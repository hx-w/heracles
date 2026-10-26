package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	root                context.Context
	jobs                sync.WaitGroup
	Store               *Store
	Garmin              *Garmin
	Harness             Harness
	WebDir              string
	Poll                time.Duration
	mu                  sync.Mutex
	coachBusy, syncBusy bool
	syncDone            chan struct{}
	phase               string
	coachError          any
	Exercises           []M
	coachWake           chan struct{}
	coachRevision       uint64
}

func New(dir, web string) (*Server, error) {
	dir, _ = filepath.Abs(dir)
	web, _ = filepath.Abs(web)
	store, e := OpenStore(dir)
	if e != nil {
		return nil, e
	}
	poll, _ := strconv.Atoi(os.Getenv("GARMIN_SYNC_SECONDS"))
	if poll == 0 {
		poll = 300
	}
	if poll < 120 {
		poll = 120
	}
	s := &Server{root: context.Background(), Store: store, Garmin: NewGarmin(dir), Harness: Harness{Dir: dir}, WebDir: web, Poll: time.Duration(poll) * time.Second, Exercises: LoadExercises(), coachWake: make(chan struct{}), coachRevision: uint64(time.Now().UnixMilli()) * 1000}
	return s, nil
}
func (s *Server) RunBackground(ctx context.Context) {
	s.root = ctx
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		for {
			c, cancel := context.WithTimeout(ctx, 4*time.Minute)
			_ = s.syncData(c)
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.Poll):
			}
		}
	}()
}
func (s *Server) syncData(ctx context.Context) error {
	s.mu.Lock()
	if s.syncBusy {
		done := s.syncDone
		s.mu.Unlock()
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.syncBusy = true
	s.syncDone = make(chan struct{})
	s.mu.Unlock()
	err := s.Sync(ctx)
	s.mu.Lock()
	s.syncBusy = false
	close(s.syncDone)
	s.mu.Unlock()
	return err
}
func (s *Server) State() M {
	s.mu.Lock()
	defer s.mu.Unlock()
	health := object(s.Store.Get("health", M{}))
	proposals, active := s.Proposals()
	metrics := array(health["metrics"])
	for _, v := range metrics {
		m := object(v)
		refreshed := metric(str(m["key"]), str(m["label"]), str(m["unit"]), m["value"], m["source_at"], str(m["fetched_at"]), str(m["data_date"]), str(m["status"]))
		m["fresh"] = refreshed["fresh"]
	}
	if metrics == nil {
		metrics = []any{}
	}
	activities := array(health["activities"])
	if len(activities) > 40 {
		activities = activities[:40]
	}
	for _, v := range activities {
		a := object(v)
		a["route_points"] = s.Store.Get("route:"+str(a["id"]), []any{})
	}
	logs := s.Store.Records("training_logs")
	if len(logs) > 30 {
		logs = logs[:30]
	}
	return M{"today": today(), "timezone": "Asia/Shanghai", "profile": s.Store.Get("profile", DefaultProfile()), "plan": s.Store.Get("plan", EmptyPlan()), "messages": s.Store.Messages(), "coach": M{"available": s.Harness.Available(), "busy": s.coachBusy, "error": s.coachError, "phase": s.phase, "revision": s.coachRevision}, "syncing": s.syncBusy, "checkin": s.Store.Get("checkin:"+today(), nil), "proposals": proposals, "active_sessions": active, "metrics": metrics, "activities": activities, "training_logs": logs, "health_history": s.VisualCatalog(), "health_changes": healthChanges(s.VisualCatalog()), "connection": M{"garmin": boolean(health["connected"]), "synced_at": health["synced_at"], "sync_error": health["sync_error"], "poll_seconds": s.Poll.Seconds()}, "exercise_catalog": s.Exercises, "exports": s.Store.Records("exports"), "export_cleanup": s.CleanupOptions()}
}
func (s *Server) Context() M {
	s.mu.Lock()
	defer s.mu.Unlock()
	health := object(s.Store.Get("health", M{}))
	_, active := s.Proposals()
	history := s.Store.Messages()
	if len(history) > 20 {
		history = history[len(history)-20:]
	}
	clean := []any{}
	for _, v := range history {
		m := object(v)
		c := M{"role": m["role"], "content": m["content"]}
		if m["sections"] != nil {
			c["sections"] = m["sections"]
		}
		clean = append(clean, c)
	}
	details := []any{}
	for i, a := range array(health["activities"]) {
		if i >= 4 {
			break
		}
		if d := s.Store.Get("activity:"+str(object(a)["id"]), nil); d != nil {
			details = append(details, privateData(d))
		}
	}
	logs := s.Store.Records("training_logs")
	if len(logs) > 20 {
		logs = logs[:20]
	}
	return M{"today": today(), "timezone": "Asia/Shanghai", "profile": s.Store.Get("profile", DefaultProfile()), "plan": s.Store.Get("plan", EmptyPlan()), "checkin": s.Store.Get("checkin:"+today(), nil), "profile_configured": s.Store.Get("profile", nil) != nil, "active_sessions": active, "history": clean, "health": privateData(health), "recent_activity_details": details, "training_logs": logs, "visualization_catalog": s.VisualCatalog(), "health_changes": healthChanges(s.VisualCatalog()), "exercise_catalog": s.Exercises, "garmin_export_capabilities": exportCapabilities()}
}
func (s *Server) tool(ctx context.Context, t M) (any, error) {
	switch str(t["action"]) {
	case "refresh_data":
		if e := s.syncData(ctx); e != nil {
			return nil, e
		}
		return M{"refreshed": true}, nil
	case "activity_details":
		return s.Activity(ctx, str(t["activity_id"]))
	case "health_details":
		day := str(t["date"])
		if day == "" {
			day = today()
		}
		if _, e := time.Parse("2006-01-02", day); e != nil {
			return nil, errors.New("日期无效")
		}
		v := object(s.Store.Get("health_daily", M{}))[day]
		if v == nil {
			return nil, errors.New("该日期尚未同步，不把最新数据当作历史")
		}
		return privateData(v), nil
	case "workout_details":
		for _, w := range array(object(s.Store.Get("plan", EmptyPlan()))["workouts"]) {
			if str(object(w)["id"]) == str(t["workout_id"]) {
				return w, nil
			}
		}
		return nil, errors.New("只能查询已同步的佳明课程")
	}
	return nil, errors.New("不支持的查询")
}
func (s *Server) coachTurn() {
	ctx, cancel := context.WithTimeout(s.root, 8*time.Minute)
	defer cancel()
	defer func() { s.mu.Lock(); s.coachBusy = false; s.phase = ""; s.notifyCoachLocked(); s.mu.Unlock() }()
	setPhase := func(v string) { s.mu.Lock(); s.phase = v; s.notifyCoachLocked(); s.mu.Unlock() }
	fail := func(e error) {
		s.mu.Lock()
		s.coachError = e.Error()
		_ = s.Store.Message("assistant", "本轮分析未完成："+e.Error(), nil)
		s.mu.Unlock()
	}
	setPhase("同步佳明活动、身体信号与主线计划")
	_ = s.syncData(ctx)
	context := s.Context()
	setPhase("分析实际训练、恢复与后续安排")
	reply, e := s.Harness.Infer(ctx, context)
	if e != nil {
		fail(e)
		return
	}
	if requests := array(reply["tool_requests"]); len(requests) > 0 {
		if len(requests) > 3 {
			fail(errors.New("本轮查询超出范围"))
			return
		}
		results := []any{}
		for _, r := range requests {
			t := object(r)
			setPhase("核实训练与恢复记录")
			data, err := s.tool(ctx, t)
			result := M{"action": t["action"], "parameters": t}
			if err != nil {
				result["error"] = err.Error()
			} else {
				result["data"] = data
			}
			results = append(results, result)
		}
		context = s.Context()
		context["tool_results"] = results
		context["tool_round_finished"] = true
		reply, e = s.Harness.Infer(ctx, context)
		if e != nil {
			fail(e)
			return
		}
		if len(array(reply["tool_requests"])) > 0 {
			fail(errors.New("教练本轮未完成数据核实"))
			return
		}
	}
	// One bounded repair round lets the coach correct a rejected structured plan.
	// Nothing is adopted or sent externally during drafting or repair.
	var prepared M
	var proposalErr error
	if p := reply["proposal"]; p != nil {
		prepared, proposalErr = s.Draft(object(p), context)
		if proposalErr != nil {
			context["validation_feedback"] = M{"error": proposalErr.Error(), "rejected_proposal": p, "instruction": "修正校验错误并返回完整回复，不要请求工具"}
			setPhase("校验课程步骤与时间，修正方案")
			fixed, err := s.Harness.Infer(ctx, context)
			if err == nil && len(array(fixed["tool_requests"])) == 0 {
				reply = fixed
				prepared = nil
				proposalErr = nil
				if p := reply["proposal"]; p != nil {
					prepared, proposalErr = s.Draft(object(p), context)
				}
			}
		}
	}
	extra := M{}
	sections := array(reply["sections"])
	size := len([]rune(str(reply["summary"])))
	for _, v := range sections {
		sec := object(v)
		if !safeText(sec["title"], 60) || len(array(sec["items"])) > 6 {
			fail(errors.New("教练回复节内容无效"))
			return
		}
		for _, i := range array(sec["items"]) {
			if !safeText(i, 1600) {
				fail(errors.New("教练回复过长或包含空项"))
				return
			}
			size += len([]rune(str(i)))
		}
	}
	if size > 6000 {
		fail(errors.New("教练回复过长"))
		return
	}
	highlights := []any{}
	for _, v := range array(reply["highlights"]) {
		h := object(v)
		kind := str(h["kind"])
		if len(highlights) < 3 && safeText(h["label"], 16) && safeText(h["text"], 100) && (kind == "result" || kind == "action" || kind == "attention") {
			highlights = append(highlights, M{"label": h["label"], "text": h["text"], "kind": kind})
		}
	}
	actions := []any{}
	for _, v := range array(reply["actions"]) {
		a := object(v)
		steps := array(a["steps"])
		if len(actions) >= 3 || !safeText(a["title"], 40) || (a["when"] != nil && !safeText(a["when"], 30)) || len(steps) == 0 || len(steps) > 4 {
			continue
		}
		valid := true
		for _, step := range steps {
			if !safeText(step, 250) {
				valid = false
			}
		}
		if valid {
			actions = append(actions, M{"title": a["title"], "when": str(a["when"]), "steps": steps})
		}
	}
	comparisons := []any{}
	for _, v := range array(reply["comparisons"]) {
		c := object(v)
		rows := array(c["items"])
		if len(comparisons) >= 2 || !safeText(c["title"], 40) || len(rows) == 0 || len(rows) > 4 {
			continue
		}
		valid := true
		for _, v := range rows {
			r := object(v)
			if !safeText(r["label"], 40) || !safeText(r["before"], 100) || !safeText(r["after"], 100) {
				valid = false
			}
		}
		if valid {
			comparisons = append(comparisons, M{"title": c["title"], "items": rows})
		}
	}
	extra["actions"] = actions
	extra["comparisons"] = comparisons
	extra["highlights"] = highlights
	extra["sections"] = sections
	visuals := []any{}
	catalog := object(context["visualization_catalog"])
	for _, v := range array(reply["visuals"]) {
		m := object(v)
		if !safeText(m["title"], 80) || (str(m["kind"]) != "trend" && str(m["kind"]) != "table") {
			continue
		}
		days := int(num(m["period_days"]))
		if days == 0 {
			match := regexp.MustCompile(`(?:近|过去|最近)\s*(\d{1,2})\s*[天日]`).FindStringSubmatch(str(m["title"]))
			if len(match) > 1 {
				days, _ = strconv.Atoi(match[1])
			}
		}
		if days < 1 || days > 30 {
			days = 7
		}
		series := []any{}
		for _, k := range array(m["metrics"]) {
			if data := catalog[str(k)]; data != nil {
				series = append(series, visualWindow(object(data), days, today()))
			}
		}
		if len(visuals) < 3 && len(series) > 0 && len(series) <= 6 {
			visuals = append(visuals, M{"kind": m["kind"], "title": m["title"], "source": "garmin", "period_days": days, "series": series})
		}
	}
	extra["visuals"] = visuals
	exercises := []any{}
	for _, eid := range array(reply["exercise_ids"]) {
		if ex := s.Exercise(str(eid)); ex != nil && len(exercises) < 4 {
			exercises = append(exercises, ex)
		}
	}
	extra["exercises"] = exercises
	if prepared != nil {
		extra["proposal_id"] = prepared["id"]
	}
	if proposalErr != nil {
		extra["proposal_error"] = "方案未保存：" + proposalErr.Error()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := reply["profile_update"]; p != nil {
		profile := object(p)
		if validateProfile(profile) == nil {
			_ = s.Store.Put("profile", profile)
		}
	}
	_ = s.Store.Message("assistant", str(reply["summary"]), extra)
	s.coachError = nil
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func errorJSON(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, M{"detail": detail})
}
func bodyJSON(w http.ResponseWriter, r *http.Request) (M, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	defer r.Body.Close()
	b, e := io.ReadAll(r.Body)
	if e != nil {
		return nil, errors.New("请求体过大或读取失败")
	}
	if !json.Valid(b) {
		return nil, errors.New("请求必须是 JSON")
	}
	v := decode(b)
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("请求必须是 JSON 对象")
	}
	return m, nil
}
func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serve) }
func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if origin := r.Header.Get("Origin"); origin != "" && origin != scheme+"://"+r.Host {
			errorJSON(w, 403, "拒绝跨站写入请求")
			return
		}
	}
	public := path == "/manifest.webmanifest" || path == "/sw.js" || strings.HasPrefix(path, "/icons/")
	if path == "/healthz" {
		writeJSON(w, 200, M{"status": "ok"})
		return
	}
	if path == "/" && r.Method == "GET" && r.URL.Query().Get("access") != "" {
		token := r.URL.Query().Get("access")
		privatePage(w, token, s.Store.Pending(token))
		return
	}
	if path == "/api/pair" && r.Method == "POST" {
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
			errorJSON(w, 415, "请从授权页面提交")
			return
		}
		if e := r.ParseForm(); e != nil {
			errorJSON(w, 413, "授权信息过大或无效")
			return
		}
		token, e := s.Store.Pair(r.Form.Get("access"))
		if e != nil {
			errorJSON(w, 400, "授权链接已使用、过期或无效")
			return
		}
		setCookie(w, r, token)
		http.Redirect(w, r, "/", 303)
		return
	}
	cookie, _ := r.Cookie(CookieName)
	token := ""
	if cookie != nil {
		token = cookie.Value
	}
	if !public || r.Method != "GET" && r.Method != "HEAD" {
		if !s.Store.Authorized(token) {
			if path == "/" {
				privatePage(w, "", false)
			} else {
				errorJSON(w, 401, "请使用私人设备授权链接访问 Heracles")
			}
			return
		}
	}
	if path == "/api/state" && r.Method == "GET" {
		setCookie(w, r, token)
		_, _ = s.Store.db.Exec("UPDATE devices SET last_seen=? WHERE token_hash=?", now(), tokenHash(token))
		writeJSON(w, 200, s.State())
		return
	}
	if path == "/api/exercises" && r.Method == "GET" {
		writeJSON(w, 200, s.Exercises)
		return
	}
	if path == "/api/coach/events" && r.Method == "GET" {
		s.coachEvents(w, r, token)
		return
	}
	if strings.HasPrefix(path, "/api/exports/") && r.Method == "POST" {
		parts := strings.Split(strings.TrimPrefix(path, "/api/exports/"), "/")
		if len(parts) != 3 || parts[2] != "remove" {
			http.NotFound(w, r)
			return
		}
		s.removeExport(w, r, parts[0], parts[1])
		return
	}
	if path == "/api/sync" && r.Method == "POST" {
		s.jobs.Add(1)
		go func() {
			defer s.jobs.Done()
			ctx, cancel := context.WithTimeout(s.root, 4*time.Minute)
			defer cancel()
			_ = s.syncData(ctx)
		}()
		writeJSON(w, 202, M{"accepted": true})
		return
	}
	if path == "/api/chat" && r.Method == "POST" {
		m, e := bodyJSON(w, r)
		if e != nil {
			errorJSON(w, 422, e.Error())
			return
		}
		message := strings.TrimSpace(str(m["message"]))
		if !textLimit(message, 4000) {
			errorJSON(w, 422, "请输入不超过4000字的训练诉求")
			return
		}
		s.mu.Lock()
		if s.coachBusy || s.syncBusy {
			s.mu.Unlock()
			errorJSON(w, 409, "教练正在处理上一条消息")
			return
		}
		if !s.Harness.Available() {
			s.mu.Unlock()
			errorJSON(w, 503, "教练未就绪，请检查服务器模型配置")
			return
		}
		s.coachBusy = true
		s.phase = "准备训练上下文"
		s.coachError = nil
		if e = s.Store.Message("user", message, nil); e != nil {
			s.coachBusy = false
			s.mu.Unlock()
			errorJSON(w, 500, "留言保存失败，尚未开始分析")
			return
		}
		s.notifyCoachLocked()
		s.mu.Unlock()
		s.jobs.Add(1)
		go func() { defer s.jobs.Done(); s.coachTurn() }()
		writeJSON(w, 202, M{"accepted": true})
		return
	}
	if path == "/api/profile" && r.Method == "POST" {
		m, e := bodyJSON(w, r)
		if e != nil {
			errorJSON(w, 422, e.Error())
			return
		}
		if e = validateProfile(m); e != nil {
			errorJSON(w, 422, e.Error())
			return
		}
		profile := M{}
		for _, k := range []string{"goal", "target_date", "weekly_days", "experience", "notes"} {
			profile[k] = m[k]
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.coachBusy || s.syncBusy {
			errorJSON(w, 409, "分析完成后再修改背景")
			return
		}
		if e = s.Store.Put("profile", profile); e != nil {
			errorJSON(w, 500, "资料保存失败")
			return
		}
		writeJSON(w, 200, profile)
		return
	}
	if path == "/api/checkin" && r.Method == "POST" {
		m, e := bodyJSON(w, r)
		if e != nil {
			errorJSON(w, 422, e.Error())
			return
		}
		fatigue, minutes := num(m["fatigue"]), num(m["available_minutes"])
		soreness := str(m["soreness"])
		if !isNumber(m["fatigue"]) || !isNumber(m["available_minutes"]) || fatigue < 1 || fatigue > 5 || fatigue != float64(int(fatigue)) || minutes < 5 || minutes > 300 || minutes != float64(int(minutes)) || !(soreness == "none" || soreness == "mild" || soreness == "pain") || len([]rune(str(m["notes"]))) > 500 {
			errorJSON(w, 422, "体感、时间或备注无效")
			return
		}
		saved := M{"fatigue": fatigue, "available_minutes": minutes, "soreness": soreness, "notes": m["notes"], "date": today(), "updated_at": now()}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.coachBusy || s.syncBusy {
			errorJSON(w, 409, "分析完成后再更新状态")
			return
		}
		if e = s.Store.Put("checkin:"+today(), saved); e != nil {
			errorJSON(w, 500, "状态保存失败")
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	if strings.HasPrefix(path, "/api/proposals/") && r.Method == "POST" {
		parts := strings.Split(strings.TrimPrefix(path, "/api/proposals/"), "/")
		if len(parts) != 2 {
			http.NotFound(w, r)
			return
		}
		if parts[1] == "publish" {
			s.publish(w, r, parts[0])
			return
		}
		record, e := s.Decide(parts[0], parts[1])
		if e != nil {
			errorJSON(w, 409, e.Error())
		} else {
			writeJSON(w, 200, record)
		}
		return
	}
	if path == "/api/training-logs" && r.Method == "POST" {
		s.logTraining(w, r)
		return
	}
	if strings.HasPrefix(path, "/api/") {
		http.NotFound(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		errorJSON(w, 405, "不支持该操作")
		return
	}
	if path == "/" {
		http.ServeFile(w, r, filepath.Join(s.WebDir, "index.html"))
		return
	}
	if strings.HasPrefix(path, "/assets/") || strings.HasPrefix(path, "/icons/") || strings.HasPrefix(path, "/exercises/") || path == "/manifest.webmanifest" || path == "/sw.js" {
		clean := filepath.Clean(path)
		if clean != path || strings.Contains(path, "\\") {
			http.NotFound(w, r)
			return
		}
		if public {
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}
		if path == "/sw.js" {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		http.ServeFile(w, r, filepath.Join(s.WebDir, strings.TrimPrefix(path, "/")))
		return
	}
	http.NotFound(w, r)
}
func ValidateOrigin(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("URL必须是HTTP(S)站点根地址")
	}
	return nil
}

func (s *Server) Wait() { s.jobs.Wait() }

func visualWindow(series M, days int, end string) M {
	result := object(clone(series))
	anchor, e := time.Parse("2006-01-02", end)
	if e != nil {
		return result
	}
	first := anchor.AddDate(0, 0, 1-days).Format("2006-01-02")
	points := []any{}
	for _, v := range array(result["points"]) {
		p := object(v)
		date := str(p["date"])
		if date >= first && date <= end {
			points = append(points, p)
		}
	}
	result["points"] = points
	return result
}
