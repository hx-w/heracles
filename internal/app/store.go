package app

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	_ "github.com/mattn/go-sqlite3"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type M = map[string]any

var zone = time.FixedZone("Asia/Shanghai", 8*3600)

func now() string   { return time.Now().In(zone).Format(time.RFC3339) }
func today() string { return time.Now().In(zone).Format("2006-01-02") }
func object(v any) M {
	if x, ok := v.(map[string]any); ok && x != nil {
		return x
	}
	return M{}
}
func array(v any) []any {
	if x, ok := v.([]any); ok && x != nil {
		return x
	}
	return []any{}
}
func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func num(v any) float64 {
	var f float64
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case json.Number:
		f, _ = x.Float64()
	case string:
		fmt.Sscan(x, &f)
	}
	return f
}
func boolean(v any) bool  { b, _ := v.(bool); return b }
func encode(v any) []byte { b, _ := json.Marshal(v); return b }
func decode(b []byte) any {
	var v any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	_ = d.Decode(&v)
	return v
}
func clone(v any) any { return decode(encode(v)) }
func id() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func hash(v any) string              { h := sha256.Sum256(encode(v)); return hex.EncodeToString(h[:]) }
func safeText(v any, n int) bool     { s, ok := v.(string); return ok && textLimit(s, n) }
func textLimit(v string, n int) bool { return strings.TrimSpace(v) != "" && len([]rune(v)) <= n }

type Store struct {
	db  *sql.DB
	Dir string
}

func OpenStore(dir string) (*Store, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	_ = os.Chmod(dir, 0700)
	path := filepath.Join(dir, "heracles.sqlite")
	db, e := sql.Open("sqlite3", "file:"+path+"?_busy_timeout=15000&_journal_mode=WAL&_foreign_keys=on")
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	schema := `CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS devices(token_hash TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,last_seen TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL,consumed_at TEXT);
 CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,payload BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS training_logs(id TEXT PRIMARY KEY,payload BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,payload BLOB NOT NULL);`
	if _, e = db.Exec(schema); e != nil {
		db.Close()
		return nil, e
	}
	_ = os.Chmod(path, 0600)
	return &Store{db: db, Dir: dir}, nil
}
func (s *Store) Close() { _ = s.db.Close() }
func (s *Store) Get(key string, fallback any) any {
	var b []byte
	if e := s.db.QueryRow("SELECT value FROM state WHERE key=?", key).Scan(&b); e != nil {
		return clone(fallback)
	}
	return decode(b)
}
func (s *Store) Put(key string, v any) error {
	_, e := s.db.Exec("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, encode(v))
	return e
}
func (s *Store) PutMany(values M) error {
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for k, v := range values {
		if _, e = tx.Exec("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, encode(v)); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (s *Store) Messages() []any { return array(s.Get("messages", []any{})) }
func (s *Store) Message(role, content string, extra M) error {
	messages := s.Messages()
	m := M{"id": id(), "role": role, "content": content, "created_at": now()}
	for k, v := range extra {
		m[k] = v
	}
	messages = append(messages, m)
	if len(messages) > 200 {
		messages = messages[len(messages)-200:]
	}
	return s.Put("messages", messages)
}
func (s *Store) Records(table string) []M {
	if table != "proposals" && table != "training_logs" && table != "exports" {
		return []M{}
	}
	rows, e := s.db.Query("SELECT payload FROM " + table + " ORDER BY rowid DESC")
	if e != nil {
		return []M{}
	}
	defer rows.Close()
	out := []M{}
	for rows.Next() {
		var b []byte
		if rows.Scan(&b) == nil {
			out = append(out, object(decode(b)))
		}
	}
	return out
}
func (s *Store) SaveRecord(table string, m M) error {
	if table != "proposals" && table != "training_logs" && table != "exports" {
		return fmt.Errorf("invalid table")
	}
	_, e := s.db.Exec("INSERT INTO "+table+" VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", str(m["id"]), encode(m))
	return e
}
func EmptyPlan() M {
	return M{"source": "garmin", "status": "missing", "sync_error": nil, "fetched_at": nil, "updated_at": nil, "name": nil, "plans": []any{}, "phases": []any{}, "workouts": []any{}}
}
func DefaultProfile() M {
	return M{"goal": "", "target_date": nil, "weekly_days": 3, "experience": "未填写", "notes": ""}
}

func isNumber(v any) bool {
	switch v.(type) {
	case json.Number, float64, int, int64:
		return true
	}
	return false
}
