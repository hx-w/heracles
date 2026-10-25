package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Garmin struct {
	mu                        sync.Mutex
	token                     M
	TokenFile, Host, AuthHost string
	Client                    *http.Client
}

func NewGarmin(dir string) *Garmin {
	region := os.Getenv("GARMIN_REGION")
	domain := "garmin.cn"
	if region == "global" {
		domain = "garmin.com"
	}
	p := os.Getenv("GARMIN_TOKEN_FILE")
	if p == "" {
		p = filepath.Join(dir, "garmin_tokens.json")
	}
	return &Garmin{TokenFile: p, Host: "https://connectapi." + domain, AuthHost: "https://diauth." + domain, Client: &http.Client{Timeout: 25 * time.Second}}
}
func (g *Garmin) load() error {
	if g.token != nil {
		return nil
	}
	info, e := os.Lstat(g.TokenFile)
	if e != nil || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("服务器尚未导入佳明认证")
	}
	b, e := os.ReadFile(g.TokenFile)
	if e != nil {
		return errors.New("无法读取佳明认证")
	}
	g.token = object(decode(b))
	if str(g.token["di_token"]) == "" {
		return errors.New("佳明认证不包含可用的 DI token")
	}
	return nil
}
func (g *Garmin) refresh(ctx context.Context) error {
	refresh, client := str(g.token["di_refresh_token"]), str(g.token["di_client_id"])
	if refresh == "" || client == "" {
		return errors.New("佳明认证已过期，请重新导入认证")
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {client}, "refresh_token": {refresh}}
	req, _ := http.NewRequestWithContext(ctx, "POST", g.AuthHost+"/di-oauth2-service/oauth/token", strings.NewReader(form.Encode()))
	req.SetBasicAuth(client, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "GCM-Android-5.23")
	res, e := g.Client.Do(req)
	if e != nil {
		return errors.New("佳明认证刷新网络失败")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("佳明认证刷新失败（%d）", res.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if e != nil {
		return e
	}
	data := object(decode(b))
	if str(data["access_token"]) == "" {
		return errors.New("佳明未返回有效认证")
	}
	g.token["di_token"] = data["access_token"]
	if str(data["refresh_token"]) != "" {
		g.token["di_refresh_token"] = data["refresh_token"]
	}
	temp := g.TokenFile + ".tmp"
	if e = os.WriteFile(temp, encode(g.token), 0600); e != nil {
		return errors.New("无法保存刷新的佳明认证")
	}
	return os.Rename(temp, g.TokenFile)
}
func (g *Garmin) bearer(ctx context.Context, force bool, previous string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if e := g.load(); e != nil {
		return "", e
	}
	token := str(g.token["di_token"])
	parts := strings.Split(token, ".")
	expired := false
	if len(parts) == 3 {
		b, _ := base64.RawURLEncoding.DecodeString(parts[1])
		expiry := num(object(decode(b))["exp"])
		expired = expiry > 0 && float64(time.Now().Unix()+120) > expiry
	}
	if expired || (force && token == previous) {
		if e := g.refresh(ctx); e != nil {
			return "", e
		}
	}
	return str(g.token["di_token"]), nil
}
func (g *Garmin) Request(ctx context.Context, method, path string, payload any) (any, error) {
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "://") {
		return nil, errors.New("佳明接口路径无效")
	}
	token, e := g.bearer(ctx, false, "")
	if e != nil {
		return nil, e
	}
	for attempt := 0; attempt < 2; attempt++ {
		var body io.Reader
		if payload != nil {
			body = bytes.NewReader(encode(payload))
		}
		req, e := http.NewRequestWithContext(ctx, method, g.Host+path, body)
		if e != nil {
			return nil, errors.New("佳明请求无效")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("User-Agent", "GCM-Android-5.23")
		req.Header.Set("X-Garmin-User-Agent", "com.garmin.android.apps.connectmobile/5.23; Android/33")
		req.Header.Set("Accept", "application/json")
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, e := g.Client.Do(req)
		if e != nil {
			return nil, errors.New("佳明网络连接失败")
		}
		b, readErr := io.ReadAll(io.LimitReader(res.Body, 20*1024*1024+1))
		res.Body.Close()
		if readErr != nil || len(b) > 20*1024*1024 {
			return nil, errors.New("佳明响应读取失败或过大")
		}
		if res.StatusCode == 401 && attempt == 0 {
			token, e = g.bearer(ctx, true, token)
			if e != nil {
				return nil, e
			}
			continue
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, fmt.Errorf("佳明接口返回 %d", res.StatusCode)
		}
		if len(b) == 0 {
			return M{}, nil
		}
		if !json.Valid(b) {
			return nil, errors.New("佳明响应不是有效 JSON")
		}
		return decode(b), nil
	}
	return nil, errors.New("佳明认证失败")
}
func (g *Garmin) Get(ctx context.Context, path string) (any, error) {
	return g.Request(ctx, "GET", path, nil)
}
func rawKey(v any, keys ...string) string {
	if m, ok := v.(map[string]any); ok {
		for _, k := range keys {
			if str(m[k]) != "" {
				return str(m[k])
			}
		}
		return ""
	}
	return str(v)
}
func sportKind(s string) string {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "running") || l == "run" || l == "trail_run":
		return "running"
	case strings.Contains(l, "cycling") || strings.Contains(l, "biking"):
		return "cycling"
	case strings.Contains(l, "strength") || l == "weight_training":
		return "strength"
	case l == "rest":
		return "rest"
	default:
		return "other"
	}
}
func workoutStatus(v any) string {
	switch strings.ToUpper(strings.ReplaceAll(rawKey(v, "statusKey", "workoutStatusKey"), "_", "")) {
	case "COMPLETE", "COMPLETED":
		return "completed"
	case "SKIP", "SKIPPED":
		return "skipped"
	case "NOTCOMPLETE", "PLANNED", "SCHEDULED", "INPROGRESS":
		return "planned"
	}
	return "unknown"
}
func steps(payload M) []any {
	out := []any{}
	for _, seg := range array(payload["workoutSegments"]) {
		out = append(out, array(object(seg)["workoutSteps"])...)
	}
	if len(out) == 0 {
		out = array(payload["workoutSteps"])
	}
	return out
}
func (g *Garmin) Plan(ctx context.Context, old M) (M, error) {
	listing, e := g.Get(ctx, "/trainingplan-service/trainingplan/plans")
	if e != nil {
		return old, e
	}
	rows := array(object(listing)["trainingPlanList"])
	if _, ok := listing.([]any); !ok {
		if _, ok := object(listing)["trainingPlanList"].([]any); !ok {
			return old, errors.New("佳明未返回可确认的计划列表，保留上次快照")
		}
	}
	if _, ok := listing.([]any); ok {
		rows = array(listing)
	}
	plan := EmptyPlan()
	plan["fetched_at"] = now()
	plans, phases, workouts := []any{}, []any{}, []any{}
	names := []string{}
	partial := false
	for _, item := range rows {
		r := object(item)
		identifier := str(r["trainingPlanId"])
		if identifier == "" {
			identifier = str(r["id"])
		}
		category := str(r["trainingPlanCategory"])
		status := rawKey(r["trainingStatus"], "statusKey")
		sport := rawKey(r["trainingType"], "typeKey", "sportTypeKey")
		if sport == "" {
			sport = rawKey(r["sportType"], "typeKey", "sportTypeKey")
		}
		meta := M{"id": identifier, "name": r["name"], "category": category, "status": status, "sport": sport, "start_date": dateOnly(r["startDate"]), "end_date": dateOnly(r["endDate"])}
		plans = append(plans, meta)
		statusLower := strings.ToLower(strings.ReplaceAll(status, "_", ""))
		if statusLower != "scheduled" && statusLower != "inprogress" {
			continue
		}
		names = append(names, str(r["name"]))
		kind := "phased"
		if category == "FBT_ADAPTIVE" {
			kind = "fbt-adaptive"
		}
		detail, err := g.Get(ctx, "/trainingplan-service/trainingplan/"+kind+"/"+url.PathEscape(identifier))
		if err != nil {
			partial = true
			for _, w := range array(old["workouts"]) {
				if str(object(w)["plan_id"]) == identifier {
					workouts = append(workouts, w)
				}
			}
			for _, p := range array(old["phases"]) {
				if str(object(p)["plan_id"]) == identifier {
					phases = append(phases, p)
				}
			}
			continue
		}
		d := object(detail)
		phaseList := array(d["adaptivePlanPhases"])
		if len(phaseList) == 0 {
			phaseList = array(d["planPhases"])
		}
		for _, ph := range phaseList {
			p := object(ph)
			phases = append(phases, M{"plan_id": identifier, "start_date": dateOnly(p["startDate"]), "end_date": dateOnly(p["endDate"]), "training_phase": rawKey(p["trainingPhase"], "phaseKey"), "current": boolean(p["currentPhase"])})
		}
		for i, t := range array(d["taskList"]) {
			task := object(t)
			w := object(task["taskWorkout"])
			day := dateOnly(task["calendarDate"])
			if day == nil {
				day = dateOnly(w["scheduledDate"])
			}
			if day == nil {
				continue
			}
			wid := str(w["workoutId"])
			if wid == "" {
				wid = str(w["workoutUuid"])
			}
			if wid == "" {
				wid = fmt.Sprintf("garmin:%s:%s:%d", identifier, day, i)
			}
			rest := boolean(w["restDay"])
			wsport := rawKey(w["sportType"], "sportTypeKey", "typeKey")
			if wsport == "" {
				wsport = sport
			}
			wkind := sportKind(wsport)
			if rest {
				wkind = "rest"
			}
			rawStatus := w["adaptiveCoachingWorkoutStatus"]
			if rawStatus == nil {
				rawStatus = w["workoutStatus"]
			}
			title := str(w["workoutName"])
			if title == "" {
				title = "佳明训练"
			}
			course := M{"id": wid, "plan_id": identifier, "date": day, "title": title, "kind": wkind, "sport": wsport, "duration_seconds": w["estimatedDurationInSecs"], "description": w["workoutDescription"], "status": workoutStatus(rawStatus), "garmin_status": rawKey(rawStatus, "statusKey"), "training_effect": w["trainingEffectLabel"], "priority": w["priorityType"], "rest_day": rest, "detail_status": "summary", "detail_error": nil, "steps": []any{}, "write_capability": "ordinary"}
			if category == "FBT_ADAPTIVE" {
				course["write_capability"] = "adaptive_read_only"
			}
			if rest {
				course["detail_status"] = "not_applicable"
			} else {
				endpoint := "/workout-service/workout/"
				if _, err := strconv.ParseInt(wid, 10, 64); err != nil {
					endpoint = "/workout-service/fbt-adaptive/"
				}
				raw, err := g.Get(ctx, endpoint+url.PathEscape(wid))
				if err != nil {
					course["detail_status"] = "error"
					course["detail_error"] = err.Error()
					partial = true
					for _, prior := range array(old["workouts"]) {
						p := object(prior)
						if str(p["id"]) == wid && str(p["date"]) == str(day) {
							course["steps"] = p["steps"]
						}
					}
				} else {
					detail := object(raw)
					course["steps"] = steps(detail)
					if len(steps(detail)) > 0 {
						course["detail_status"] = "available"
					}
					if detail["estimatedDurationInSecs"] != nil {
						course["duration_seconds"] = detail["estimatedDurationInSecs"]
					}
				}
			}
			workouts = append(workouts, course)
		}
	}
	sort.SliceStable(workouts, func(i, j int) bool { return str(object(workouts[i])["date"]) < str(object(workouts[j])["date"]) })
	plan["plans"], plan["phases"], plan["workouts"], plan["name"] = plans, phases, workouts, strings.Join(names, " / ")
	if len(names) > 0 {
		plan["status"] = "available"
	}
	if partial {
		plan["status"] = "error"
		plan["sync_error"] = "部分佳明课程暂时无法读取，已保留可用来源"
	}
	plan["updated_at"] = now()
	return plan, nil
}
func dateOnly(v any) any {
	s := str(v)
	if len(s) >= 10 {
		if _, e := time.Parse("2006-01-02", s[:10]); e == nil {
			return s[:10]
		}
	}
	return nil
}
func timestamp(v any) any {
	if v == nil {
		return nil
	}
	if n := num(v); n > 1000000000 {
		if n > 1e11 {
			n /= 1000
		}
		return time.Unix(int64(n), 0).In(zone).Format(time.RFC3339)
	}
	s := str(v)
	if t, e := time.Parse(time.RFC3339, s); e == nil {
		return t.In(zone).Format(time.RFC3339)
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02 15:04:05 -0700"} {
		if t, e := time.ParseInLocation(layout, s, zone); e == nil {
			return t.Format(time.RFC3339)
		}
	}
	return nil
}
func activity(raw M) M {
	distance, seconds := num(raw["distance"]), num(raw["duration"])
	var pace any
	if distance > 0 && seconds > 0 {
		s := int(seconds/(distance/1000) + .5)
		pace = fmt.Sprintf("%d:%02d /km", s/60, s%60)
	}
	at := timestamp(raw["startTimeLocal"])
	if at == nil {
		if raw["startTimeGMT"] != nil {
			gmt := str(raw["startTimeGMT"])
			gmt = strings.ReplaceAll(gmt, " ", "T")
			if !strings.HasSuffix(gmt, "Z") {
				gmt += "Z"
			}
			at = timestamp(gmt)
		}
	}
	if at == nil {
		at = timestamp(raw["beginTimestamp"])
	}
	return M{"id": raw["activityId"], "date": at, "average_speed_kmh": roundedDivision(raw["averageSpeed"], 1.0/3.6, 10), "name": raw["activityName"], "sport": object(raw["activityType"])["typeKey"], "distance_km": roundedDivision(raw["distance"], 1000, 100), "duration_minutes": roundedDivision(raw["duration"], 60, 10), "pace": pace, "average_hr": raw["averageHR"], "max_hr": raw["maxHR"], "cadence": raw["averageRunningCadenceInStepsPerMinute"], "elevation_gain": raw["elevationGain"], "aerobic_effect": raw["aerobicTrainingEffect"], "anaerobic_effect": raw["anaerobicTrainingEffect"], "calories": raw["calories"]}
}

func roundedDivision(v any, divisor, precision float64) any {
	if v == nil {
		return nil
	}
	return math.Round(num(v)/divisor*precision) / precision
}
