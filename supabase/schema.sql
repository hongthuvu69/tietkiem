-- Tiết Kiệm: sổ tiết kiệm chung, đồng bộ giữa các iPhone bằng "mã sổ".
-- Chạy trong Supabase Dashboard → SQL Editor → New query → dán toàn bộ → Run.
-- Chạy lại nhiều lần cũng được: script không xóa dữ liệu đã có.
--
-- Không cần tài khoản đăng nhập: ai có mã sổ thì xem và ghi được sổ đó.
-- App chỉ gọi 3 hàm tk_create / tk_pull / tk_push. Hai bảng bị khóa hoàn toàn với
-- publishable key, nên không ai đọc được bảng nếu không biết mã.

-- ---------- Bảng ----------

-- Mỗi sổ: chỉ lưu bản băm SHA-256 của mã, không lưu mã gốc.
create table if not exists public.tk_wallets (
    id             uuid        primary key default gen_random_uuid(),
    code_hash      bytea       not null unique,
    name           text        not null default 'Sổ tiết kiệm',
    initial_amount bigint      not null default 0,        -- số tiền ban đầu (đồng)
    weekly_limit   bigint      not null default 1500000,  -- hạn mức chi mỗi tuần (đồng)
    settings_upd   bigint      not null default 0,        -- lúc sửa cài đặt (ms), bản sửa sau cùng thắng
    created_at     timestamptz not null default now()
);

-- Mỗi giao dịch cộng/trừ tiền. id do máy tạo ra, nên đẩy lại nhiều lần cũng không bị trùng.
create table if not exists public.tk_entries (
    id          uuid        primary key,
    wallet_id   uuid        not null references public.tk_wallets (id) on delete cascade,
    kind        text        not null check (kind in ('in', 'out')),   -- in = thêm tiền, out = chi tiêu
    amount      bigint      not null check (amount > 0 and amount <= 100000000000),
    note        text        not null default '',
    cat         text        not null default '',
    by_name     text        not null default '',   -- ai nhập
    at_ms       bigint      not null,              -- thời điểm giao dịch (ms)
    upd_ms      bigint      not null,              -- lúc sửa trên máy (ms), bản sửa sau cùng thắng
    deleted     boolean     not null default false,
    rev         bigint      not null default 0,    -- số thứ tự thay đổi, máy chủ cấp, để kéo phần mới
    occurred_at timestamptz,                       -- = at_ms, cho dễ đọc trong Table Editor
    server_at   timestamptz not null default now()
);

create index if not exists tk_entries_wallet_rev on public.tk_entries (wallet_id, rev);

create sequence if not exists public.tk_rev_seq;

-- Mỗi lần thêm/sửa một giao dịch thì cấp số rev mới.
create or replace function public.tk_touch() returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.rev := nextval('public.tk_rev_seq');
    new.occurred_at := to_timestamp(new.at_ms / 1000.0);
    new.server_at := now();
    return new;
end
$$;

drop trigger if exists tk_entries_touch on public.tk_entries;
create trigger tk_entries_touch
    before insert or update on public.tk_entries
    for each row execute function public.tk_touch();

-- ---------- Bảo mật ----------
-- Bật RLS và không tạo policy nào: publishable key không đọc/ghi thẳng vào bảng được.
alter table public.tk_wallets enable row level security;
alter table public.tk_entries enable row level security;
revoke all on table public.tk_wallets, public.tk_entries from anon, authenticated;
revoke all on sequence public.tk_rev_seq from anon, authenticated;
revoke all on function public.tk_touch() from public, anon, authenticated;

-- Băm mã sổ (bỏ dấu gạch, khoảng trắng; không phân biệt hoa thường).
create or replace function public.tk_hash(p_code text) returns bytea
language sql
immutable
set search_path = ''
as $$
    select sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'UTF8'))
$$;
revoke all on function public.tk_hash(text) from public, anon, authenticated;

-- ---------- API cho app ----------

-- Tạo sổ mới. Mã do app sinh ngẫu nhiên (12 ký tự, khoảng 60 bit).
create or replace function public.tk_create(p_code text, p_wallet jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    if length(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')) < 12 then
        raise exception 'TK_WEAK_CODE' using errcode = 'P0001';
    end if;
    insert into public.tk_wallets (code_hash, name, initial_amount, weekly_limit, settings_upd)
    values (
        public.tk_hash(p_code),
        left(coalesce(nullif(btrim(p_wallet ->> 'name'), ''), 'Sổ tiết kiệm'), 60),
        greatest(coalesce((p_wallet ->> 'initial')::bigint, 0), 0),
        greatest(coalesce((p_wallet ->> 'limit')::bigint, 1500000), 0),
        coalesce((p_wallet ->> 'upd')::bigint, 0)
    );
    return jsonb_build_object('ok', true);
exception
    when unique_violation then
        raise exception 'TK_EXISTS' using errcode = 'P0001';
end
$$;

-- Kéo cài đặt sổ và các giao dịch có rev > p_since (tối đa 500 dòng mỗi lần).
create or replace function public.tk_pull(p_code text, p_since bigint default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_w    public.tk_wallets;
    v_rows jsonb;
    v_n    int;
    v_max  bigint;
begin
    select * into v_w from public.tk_wallets where code_hash = public.tk_hash(p_code);
    if not found then
        raise exception 'TK_NOT_FOUND' using errcode = 'P0001';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
               'id', e.id, 'kind', e.kind, 'amount', e.amount, 'note', e.note, 'cat', e.cat,
               'by', e.by_name, 'at', e.at_ms, 'upd', e.upd_ms, 'del', e.deleted, 'rev', e.rev
           ) order by e.rev), '[]'::jsonb),
           count(*),
           max(e.rev)
      into v_rows, v_n, v_max
      from (select * from public.tk_entries
             where wallet_id = v_w.id and rev > coalesce(p_since, 0)
             order by rev
             limit 500) e;

    return jsonb_build_object(
        'wallet', jsonb_build_object(
            'name', v_w.name, 'initial', v_w.initial_amount,
            'limit', v_w.weekly_limit, 'upd', v_w.settings_upd),
        'entries', v_rows,
        'rev', coalesce(v_max, coalesce(p_since, 0)),
        'more', v_n >= 500,
        'now', (extract(epoch from now()) * 1000)::bigint
    );
end
$$;

-- Đẩy giao dịch mới/đã sửa (tối đa 500 dòng) và cài đặt sổ (nếu có).
-- Với mỗi giao dịch, bản có upd mới hơn mới được ghi đè.
create or replace function public.tk_push(p_code text, p_entries jsonb default '[]'::jsonb, p_wallet jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id uuid;
    v_e  jsonb;
    v_n  int := 0;
begin
    select id into v_id from public.tk_wallets where code_hash = public.tk_hash(p_code);
    if v_id is null then
        raise exception 'TK_NOT_FOUND' using errcode = 'P0001';
    end if;

    -- Xếp hàng các lần ghi vào cùng một sổ, để rev tăng đúng theo thứ tự commit
    -- (máy kia kéo theo rev sẽ không bỏ sót dòng nào).
    perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));

    if jsonb_typeof(p_entries) = 'array' then
        if jsonb_array_length(p_entries) > 500 then
            raise exception 'TK_TOO_MANY' using errcode = 'P0001';
        end if;
        for v_e in select value from jsonb_array_elements(p_entries) loop
            insert into public.tk_entries as t
                (id, wallet_id, kind, amount, note, cat, by_name, at_ms, upd_ms, deleted)
            values (
                (v_e ->> 'id')::uuid, v_id, v_e ->> 'kind', (v_e ->> 'amount')::bigint,
                left(coalesce(v_e ->> 'note', ''), 200),
                left(coalesce(v_e ->> 'cat', ''), 30),
                left(coalesce(v_e ->> 'by', ''), 30),
                (v_e ->> 'at')::bigint, (v_e ->> 'upd')::bigint,
                coalesce((v_e ->> 'del')::boolean, false)
            )
            on conflict (id) do update set
                kind = excluded.kind, amount = excluded.amount, note = excluded.note,
                cat = excluded.cat, by_name = excluded.by_name, at_ms = excluded.at_ms,
                upd_ms = excluded.upd_ms, deleted = excluded.deleted
            where t.wallet_id = excluded.wallet_id and excluded.upd_ms > t.upd_ms;
            v_n := v_n + 1;
        end loop;
    end if;

    if jsonb_typeof(p_wallet) = 'object' then
        update public.tk_wallets set
            name           = left(coalesce(nullif(btrim(p_wallet ->> 'name'), ''), name), 60),
            initial_amount = greatest(coalesce((p_wallet ->> 'initial')::bigint, initial_amount), 0),
            weekly_limit   = greatest(coalesce((p_wallet ->> 'limit')::bigint, weekly_limit), 0),
            settings_upd   = (p_wallet ->> 'upd')::bigint
        where id = v_id and coalesce((p_wallet ->> 'upd')::bigint, 0) > settings_upd;
    end if;

    return jsonb_build_object('ok', true, 'n', v_n);
end
$$;

revoke all on function public.tk_create(text, jsonb) from public;
revoke all on function public.tk_pull(text, bigint) from public;
revoke all on function public.tk_push(text, jsonb, jsonb) from public;
grant execute on function public.tk_create(text, jsonb) to anon, authenticated;
grant execute on function public.tk_pull(text, bigint) to anon, authenticated;
grant execute on function public.tk_push(text, jsonb, jsonb) to anon, authenticated;

-- Báo cho API nạp lại danh sách hàm mới.
notify pgrst, 'reload schema';
