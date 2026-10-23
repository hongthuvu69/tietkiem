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

-- Máy đã nhập/sửa giao dịch (để không gửi thông báo cho chính máy đó). Thêm ở bản có thông báo.
alter table public.tk_entries add column if not exists dev text not null default '';

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
                (id, wallet_id, kind, amount, note, cat, by_name, dev, at_ms, upd_ms, deleted)
            values (
                (v_e ->> 'id')::uuid, v_id, v_e ->> 'kind', (v_e ->> 'amount')::bigint,
                left(coalesce(v_e ->> 'note', ''), 200),
                left(coalesce(v_e ->> 'cat', ''), 30),
                left(coalesce(v_e ->> 'by', ''), 30),
                left(coalesce(v_e ->> 'dev', ''), 40),
                (v_e ->> 'at')::bigint, (v_e ->> 'upd')::bigint,
                coalesce((v_e ->> 'del')::boolean, false)
            )
            on conflict (id) do update set
                kind = excluded.kind, amount = excluded.amount, note = excluded.note,
                cat = excluded.cat, by_name = excluded.by_name, dev = excluded.dev, at_ms = excluded.at_ms,
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

-- ============================================================
-- Thông báo đẩy (Web Push) lên iPhone
-- Khi có giao dịch mới, trigger gọi Edge Function "tk-notify" (supabase/functions/tk-notify).
-- Hàm đó hỏi tk_notify_plan xem cần báo gì, cho máy nào, rồi gửi qua Apple/Google.
-- ============================================================

-- Mỗi máy đã bật thông báo: địa chỉ nhận (endpoint) và khóa mã hóa do trình duyệt cấp.
create table if not exists public.tk_push_subs (
    endpoint   text        primary key,
    wallet_id  uuid        not null references public.tk_wallets (id) on delete cascade,
    p256dh     text        not null,
    auth       text        not null,
    dev        text        not null default '',
    by_name    text        not null default '',
    prefs      jsonb       not null default '{"entries": true, "alerts": true, "weekly": true}',
    updated_at timestamptz not null default now()
);
create index if not exists tk_push_subs_wallet on public.tk_push_subs (wallet_id);

-- Chống gửi trùng: mỗi lần sửa (rev) của một giao dịch chỉ xử lý một lần.
create table if not exists public.tk_notified (
    entry_id uuid   not null,
    rev      bigint not null,
    primary key (entry_id, rev)
);

-- Cảnh báo hạn mức / tổng kết đã gửi: mỗi sổ, mỗi tuần, mỗi loại một lần.
create table if not exists public.tk_alert_log (
    wallet_id uuid        not null references public.tk_wallets (id) on delete cascade,
    week_ms   bigint      not null,
    level     text        not null,
    at        timestamptz not null default now(),
    primary key (wallet_id, week_ms, level)
);

-- Cấu hình máy chủ (cặp khóa VAPID để ký thông báo). Chỉ Edge Function đọc được.
create table if not exists public.tk_config (
    key   text primary key,
    value text not null
);

alter table public.tk_push_subs enable row level security;
alter table public.tk_notified  enable row level security;
alter table public.tk_alert_log enable row level security;
alter table public.tk_config    enable row level security;
revoke all on table public.tk_push_subs, public.tk_notified, public.tk_alert_log, public.tk_config from anon, authenticated;

-- ---------- Hàm phụ ----------

-- 1650000 → '1.650.000đ'
create or replace function public.tk_fmt(n bigint) returns text
language sql immutable set search_path = ''
as $$
    select case when n < 0 then '−' else '' end
        || replace(to_char(abs(n), 'FM999,999,999,999,990'), ',', '.') || 'đ'
$$;

create or replace function public.tk_cat(p_kind text, p_key text) returns text
language sql immutable set search_path = ''
as $$
    select case when p_kind = 'in' then
        case p_key when 'luong' then '💼 Lương' when 'thuong' then '🎉 Thưởng' when 'gui' then '🐷 Bỏ ống'
                   when 'lai' then '📈 Tiền lãi' else '📌 Khác' end
    else
        case p_key when 'an' then '🍜 Ăn uống' when 'dilai' then '🛵 Đi lại' when 'muasam' then '🛍️ Mua sắm'
                   when 'hoadon' then '🧾 Hóa đơn' when 'giaitri' then '🎬 Giải trí' when 'suckhoe' then '💊 Sức khỏe'
                   when 'qua' then '🎁 Quà, hiếu hỉ' else '📌 Khác' end
    end
$$;

-- Thứ Hai 00:00 (giờ Việt Nam) của tuần chứa thời điểm p_ms, tính bằng ms.
create or replace function public.tk_week_ms(p_ms bigint) returns bigint
language sql stable set search_path = ''
as $$
    select (extract(epoch from (date_trunc('week', to_timestamp(p_ms / 1000.0) at time zone 'Asia/Ho_Chi_Minh')
                               at time zone 'Asia/Ho_Chi_Minh')) * 1000)::bigint
$$;

-- Danh sách máy nhận của một sổ: bỏ máy p_skip_dev, chỉ lấy máy bật loại thông báo p_pref.
create or replace function public.tk_recipients(p_wallet uuid, p_skip_dev text, p_pref text) returns jsonb
language sql stable set search_path = ''
as $$
    select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
      from public.tk_push_subs s
     where s.wallet_id = p_wallet
       and (coalesce(p_skip_dev, '') = '' or s.dev <> p_skip_dev)
       and coalesce((s.prefs ->> p_pref)::boolean, true)
$$;

revoke all on function public.tk_fmt(bigint) from public, anon, authenticated;
revoke all on function public.tk_cat(text, text) from public, anon, authenticated;
revoke all on function public.tk_week_ms(bigint) from public, anon, authenticated;
revoke all on function public.tk_recipients(uuid, text, text) from public, anon, authenticated;

-- ---------- API cho app: bật / tắt thông báo trên một máy ----------

create or replace function public.tk_subscribe(p_code text, p_sub jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id uuid;
begin
    select id into v_id from public.tk_wallets where code_hash = public.tk_hash(p_code);
    if v_id is null then
        raise exception 'TK_NOT_FOUND' using errcode = 'P0001';
    end if;
    if coalesce(p_sub ->> 'endpoint', '') !~ '^https://' or length(p_sub ->> 'endpoint') > 1000
       or coalesce(p_sub ->> 'p256dh', '') = '' or coalesce(p_sub ->> 'auth', '') = '' then
        raise exception 'TK_BAD_SUB' using errcode = 'P0001';
    end if;
    insert into public.tk_push_subs as s (endpoint, wallet_id, p256dh, auth, dev, by_name, prefs, updated_at)
    values (
        p_sub ->> 'endpoint', v_id, left(p_sub ->> 'p256dh', 200), left(p_sub ->> 'auth', 100),
        left(coalesce(p_sub ->> 'dev', ''), 40), left(coalesce(p_sub ->> 'by', ''), 30),
        coalesce(p_sub -> 'prefs', '{"entries": true, "alerts": true, "weekly": true}'::jsonb), now()
    )
    on conflict (endpoint) do update set
        wallet_id = excluded.wallet_id, p256dh = excluded.p256dh, auth = excluded.auth,
        dev = excluded.dev, by_name = excluded.by_name, prefs = excluded.prefs, updated_at = now();
    -- Mỗi sổ giữ tối đa 10 máy, bỏ máy lâu không cập nhật.
    delete from public.tk_push_subs
     where wallet_id = v_id
       and endpoint not in (select endpoint from public.tk_push_subs where wallet_id = v_id order by updated_at desc limit 10);
    return jsonb_build_object('ok', true);
end
$$;

create or replace function public.tk_unsubscribe(p_code text, p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    delete from public.tk_push_subs
     where endpoint = p_endpoint
       and wallet_id = (select id from public.tk_wallets where code_hash = public.tk_hash(p_code));
    return jsonb_build_object('ok', true);
end
$$;

revoke all on function public.tk_subscribe(text, jsonb) from public;
revoke all on function public.tk_unsubscribe(text, text) from public;
grant execute on function public.tk_subscribe(text, jsonb) to anon, authenticated;
grant execute on function public.tk_unsubscribe(text, text) to anon, authenticated;

-- ---------- Dành riêng cho Edge Function (service_role) ----------

-- Một giao dịch vừa thêm/sửa: cần gửi thông báo gì, cho máy nào.
create or replace function public.tk_notify_plan(p_entry uuid, p_rev bigint, p_op text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    e      public.tk_entries;
    w      public.tk_wallets;
    msgs   jsonb := '[]'::jsonb;
    n      int;
    bal    bigint;
    wk     bigint;
    spent  bigint;
    lvl    text;
    top    text;
begin
    select * into e from public.tk_entries where id = p_entry;
    if not found or e.rev <> p_rev or e.deleted then
        return jsonb_build_object('messages', msgs);
    end if;
    insert into public.tk_notified (entry_id, rev) values (p_entry, p_rev) on conflict do nothing;
    get diagnostics n = row_count;
    if n = 0 then
        return jsonb_build_object('messages', msgs);
    end if;
    select * into w from public.tk_wallets where id = e.wallet_id;
    select w.initial_amount + coalesce(sum(case when x.kind = 'in' then x.amount else -x.amount end), 0)
      into bal from public.tk_entries x where x.wallet_id = w.id and not x.deleted;

    -- Giao dịch mới: báo cho máy kia.
    if p_op = 'INSERT' then
        msgs := msgs || jsonb_build_object(
            'to', public.tk_recipients(w.id, e.dev, 'entries'),
            'title', coalesce(nullif(e.by_name, ''), 'Ai đó')
                     || case when e.kind = 'in' then ' vừa thêm ' else ' vừa chi ' end || public.tk_fmt(e.amount),
            'body', public.tk_cat(e.kind, e.cat) || case when e.note <> '' then ' · ' || e.note else '' end
                    || E'\nSố dư: ' || public.tk_fmt(bal),
            'tag', 'tx-' || e.id);
    end if;

    -- Khoản chi trong tuần này: kiểm tra hạn mức, mỗi mức chỉ báo một lần mỗi tuần.
    if e.kind = 'out' and w.weekly_limit > 0 then
        wk := public.tk_week_ms(e.at_ms);
        if wk = public.tk_week_ms((extract(epoch from now()) * 1000)::bigint) then
            select coalesce(sum(x.amount), 0) into spent from public.tk_entries x
             where x.wallet_id = w.id and not x.deleted and x.kind = 'out'
               and x.at_ms >= wk and x.at_ms < wk + 7 * 86400000;
            lvl := case when spent > w.weekly_limit then 'over'
                        when spent >= w.weekly_limit * 0.8 then 'near' end;
            if lvl is not null then
                insert into public.tk_alert_log (wallet_id, week_ms, level) values (w.id, wk, lvl) on conflict do nothing;
                get diagnostics n = row_count;
                if n > 0 and lvl = 'over' then
                    select public.tk_cat('out', g.cat) || ' ' || public.tk_fmt(g.total) into top
                      from (select x.cat, sum(x.amount)::bigint as total from public.tk_entries x
                             where x.wallet_id = w.id and not x.deleted and x.kind = 'out'
                               and x.at_ms >= wk and x.at_ms < wk + 7 * 86400000
                             group by x.cat order by total desc limit 1) g;
                    msgs := msgs || jsonb_build_object(
                        'to', public.tk_recipients(w.id, e.dev, 'alerts'),
                        'title', '⚠️ Vượt hạn mức chi tiêu tuần',
                        'body', 'Tuần này đã chi ' || public.tk_fmt(spent) || ' / ' || public.tk_fmt(w.weekly_limit)
                                || ' (vượt ' || public.tk_fmt(spent - w.weekly_limit) || ').'
                                || coalesce(E'\nChi nhiều nhất: ' || top, ''),
                        'tag', 'limit-' || wk);
                elsif n > 0 and lvl = 'near' then
                    msgs := msgs || jsonb_build_object(
                        'to', public.tk_recipients(w.id, e.dev, 'alerts'),
                        'title', 'Sắp chạm hạn mức chi tiêu tuần',
                        'body', 'Tuần này đã chi ' || public.tk_fmt(spent) || ' / ' || public.tk_fmt(w.weekly_limit)
                                || ', còn ' || public.tk_fmt(w.weekly_limit - spent) || '.',
                        'tag', 'limit-' || wk);
                end if;
            end if;
        end if;
    end if;
    return jsonb_build_object('messages', msgs);
end
$$;

-- Tổng kết tuần (chạy tối Chủ Nhật): mỗi sổ có máy bật thông báo nhận một tin.
create or replace function public.tk_weekly_plan()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    wk   bigint := public.tk_week_ms((extract(epoch from now()) * 1000)::bigint);
    w    public.tk_wallets;
    msgs jsonb := '[]'::jsonb;
    n    int;
    tin  bigint;
    tout bigint;
    bal  bigint;
    lim  text;
begin
    for w in select * from public.tk_wallets t
              where exists (select 1 from public.tk_push_subs s where s.wallet_id = t.id) loop
        insert into public.tk_alert_log (wallet_id, week_ms, level) values (w.id, wk, 'weekly') on conflict do nothing;
        get diagnostics n = row_count;
        continue when n = 0;
        select coalesce(sum(x.amount) filter (where x.kind = 'in'), 0), coalesce(sum(x.amount) filter (where x.kind = 'out'), 0)
          into tin, tout from public.tk_entries x
         where x.wallet_id = w.id and not x.deleted and x.at_ms >= wk and x.at_ms < wk + 7 * 86400000;
        select w.initial_amount + coalesce(sum(case when x.kind = 'in' then x.amount else -x.amount end), 0)
          into bal from public.tk_entries x where x.wallet_id = w.id and not x.deleted;
        lim := case when w.weekly_limit <= 0 then ''
                    when tout > w.weekly_limit then E'\n⚠️ Vượt hạn mức ' || public.tk_fmt(tout - w.weekly_limit)
                    else E'\n✓ Dưới hạn mức ' || public.tk_fmt(w.weekly_limit - tout) end;
        msgs := msgs || jsonb_build_object(
            'to', public.tk_recipients(w.id, '', 'weekly'),
            'title', '📊 Tổng kết tuần ' || to_char(to_timestamp(wk / 1000.0) at time zone 'Asia/Ho_Chi_Minh', 'DD/MM')
                     || ' – ' || to_char(to_timestamp((wk + 6 * 86400000) / 1000.0) at time zone 'Asia/Ho_Chi_Minh', 'DD/MM'),
            'body', 'Thêm vào ' || public.tk_fmt(tin) || ' · Chi ra ' || public.tk_fmt(tout) || lim
                    || E'\nSố dư: ' || public.tk_fmt(bal),
            'tag', 'week-' || wk);
    end loop;
    return jsonb_build_object('messages', msgs);
end
$$;

-- Máy bấm "Gửi thử": kiểm tra máy đó thuộc đúng sổ.
create or replace function public.tk_test_sub(p_code text, p_endpoint text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
      from public.tk_push_subs s
     where s.endpoint = p_endpoint
       and s.wallet_id = (select id from public.tk_wallets where code_hash = public.tk_hash(p_code))
$$;

-- Máy đã gỡ app / tắt thông báo (Apple trả 404/410): bỏ khỏi danh sách.
create or replace function public.tk_drop_sub(p_endpoint text)
returns void
language sql
security definer
set search_path = ''
as $$
    delete from public.tk_push_subs where endpoint = p_endpoint
$$;

create or replace function public.tk_config_get(p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select value from public.tk_config where key = p_key
$$;

-- Ghi giá trị nếu chưa có, trả về giá trị đang dùng (an toàn khi hai lần gọi cùng lúc).
create or replace function public.tk_config_init(p_key text, p_value text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.tk_config (key, value) values (p_key, p_value) on conflict do nothing;
    return (select value from public.tk_config where key = p_key);
end
$$;

do $$
declare
    f text;
begin
    foreach f in array array[
        'public.tk_notify_plan(uuid, bigint, text)', 'public.tk_weekly_plan()', 'public.tk_test_sub(text, text)',
        'public.tk_drop_sub(text)', 'public.tk_config_get(text)', 'public.tk_config_init(text, text)'] loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to service_role', f);
    end loop;
end
$$;

-- ---------- Trigger: có giao dịch thì gọi Edge Function ----------

do $$
begin
    create extension if not exists pg_net;
exception when others then
    raise notice 'Chưa bật được pg_net (cần cho thông báo): %', sqlerrm;
end
$$;

create or replace function public.tk_after_entry() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Chỉ gọi khi sổ có máy bật thông báo. Lỗi ở đây không được làm hỏng việc lưu giao dịch.
    if exists (select 1 from public.tk_push_subs s where s.wallet_id = new.wallet_id) then
        begin
            perform net.http_post(
                url := 'https://gbuydsgtsypfepfxmidd.supabase.co/functions/v1/tk-notify',
                body := jsonb_build_object('entry', new.id, 'rev', new.rev, 'op', tg_op),
                headers := '{"Content-Type": "application/json"}'::jsonb);
        exception when others then
            raise warning 'tk-notify: %', sqlerrm;
        end;
    end if;
    return null;
end
$$;
revoke all on function public.tk_after_entry() from public, anon, authenticated;

drop trigger if exists tk_entries_notify on public.tk_entries;
create trigger tk_entries_notify
    after insert or update on public.tk_entries
    for each row when (not new.deleted)
    execute function public.tk_after_entry();

-- Tổng kết tuần: 20:00 tối Chủ Nhật giờ Việt Nam (13:00 UTC). Không bật được pg_cron thì bỏ qua.
do $$
begin
    create extension if not exists pg_cron;
    perform cron.schedule('tk-weekly', '0 13 * * 0', $cron$
        select net.http_post(
            url := 'https://gbuydsgtsypfepfxmidd.supabase.co/functions/v1/tk-notify',
            body := '{"weekly": true}'::jsonb,
            headers := '{"Content-Type": "application/json"}'::jsonb)
    $cron$);
exception when others then
    raise notice 'Bỏ qua lịch tổng kết tuần: %', sqlerrm;
end
$$;

-- Báo cho API nạp lại danh sách hàm mới.
notify pgrst, 'reload schema';
