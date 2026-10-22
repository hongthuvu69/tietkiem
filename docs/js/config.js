// Máy chủ Supabase lưu sổ (dùng chung project với WordFlow, dữ liệu nằm ở các bảng tk_*).
// Publishable key được thiết kế để công khai: bảng bị khóa, app chỉ gọi được các hàm tk_*
// và phải có đúng mã sổ. TUYỆT ĐỐI không dán secret / service_role key vào đây.
export const SUPABASE_URL = "https://gbuydsgtsypfepfxmidd.supabase.co";
export const SUPABASE_KEY = "sb_publishable_PeyXyw3Td0ENT01cswO05w_gls6gAy_";
