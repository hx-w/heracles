package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net/http"
	"time"
)

const CookieName = "heracles_device"
const CookieAge = 400 * 24 * 3600

func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
func (s *Store) Invite() (string, error) {
	token := id() + id()
	_, e := s.db.Exec("INSERT INTO invites VALUES (?,?,NULL)", tokenHash(token), time.Now().Add(24*time.Hour).Format(time.RFC3339))
	return token, e
}
func (s *Store) Pending(token string) bool {
	if len(token) > 128 || token == "" {
		return false
	}
	var expiry string
	var consumed *string
	e := s.db.QueryRow("SELECT expires_at,consumed_at FROM invites WHERE token_hash=?", tokenHash(token)).Scan(&expiry, &consumed)
	t, _ := time.Parse(time.RFC3339, expiry)
	return e == nil && consumed == nil && time.Now().Before(t)
}
func (s *Store) Pair(token string) (string, error) {
	if len(token) > 128 || token == "" {
		return "", errors.New("授权链接无效")
	}
	tx, e := s.db.Begin()
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	var expiry string
	var consumed *string
	e = tx.QueryRow("SELECT expires_at,consumed_at FROM invites WHERE token_hash=?", tokenHash(token)).Scan(&expiry, &consumed)
	t, _ := time.Parse(time.RFC3339, expiry)
	if e != nil || consumed != nil || !time.Now().Before(t) {
		return "", errors.New("授权链接已使用、过期或无效")
	}
	result, e := tx.Exec("UPDATE invites SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL", now(), tokenHash(token))
	if e != nil {
		return "", e
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return "", errors.New("授权链接已使用")
	}
	token = id() + id()
	_, e = tx.Exec("INSERT INTO devices VALUES (?,?,?,?)", tokenHash(token), id(), now(), now())
	if e != nil {
		return "", e
	}
	return token, tx.Commit()
}
func (s *Store) Authorized(token string) bool {
	if token == "" || len(token) > 128 {
		return false
	}
	var one int
	return s.db.QueryRow("SELECT 1 FROM devices WHERE token_hash=?", tokenHash(token)).Scan(&one) == nil
}
func (s *Store) RevokeAll() error {
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("DELETE FROM devices"); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE invites SET consumed_at=? WHERE consumed_at IS NULL", now()); e != nil {
		return e
	}
	return tx.Commit()
}
func setCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: token, Path: "/", HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteStrictMode, MaxAge: CookieAge})
}
func privatePage(w http.ResponseWriter, token string, valid bool) {
	title, text, form := "你的私人训练空间", "活动、身体信号和教练对话仅对已授权设备开放。请使用私人设备授权链接。", ""
	if valid {
		title = "授权这台设备"
		text = "授权一次，即可持续使用。请勿转发此链接。"
		form = fmt.Sprintf(`<form method="post" action="/api/pair"><input type="hidden" name="access" value="%s"><button>授权此设备</button></form>`, html.EscapeString(token))
	}
	// Navigation POSTs need a non-null Origin; send only the origin, never invitation queries.
	w.Header().Set("Referrer-Policy", "strict-origin")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	if !valid {
		w.WriteHeader(401)
	}
	fmt.Fprintf(w, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f6f7f4"><title>Heracles · 私人教练</title><style>html{color-scheme:light;background:#f6f7f4;color:#1c2922;font-family:system-ui,-apple-system,"PingFang SC",sans-serif}body{margin:0;min-height:100dvh;display:grid;place-items:center}main{max-width:380px;padding:32px}h1{font-size:24px;margin-top:42px}p,small{color:#58665d;line-height:1.8}button{width:100%%;padding:15px;border:0;border-radius:12px;background:#245d42;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:focus-visible{outline:3px solid #245d42;outline-offset:4px}small{display:block;margin-top:30px;font-size:14px}body{font-size:16px}</style><main><h2>Heracles.</h2><h1>%s</h1><p>%s</p>%s<small>设备授权长期有效；清除网站数据或更换设备需重新授权。</small></main></html>`, title, text, form)
}
