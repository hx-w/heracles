package app

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"
)

func field(v any, path ...string) any {
	for _, p := range path {
		v = object(v)[p]
	}
	return v
}
func divide(v any, d float64) any {
	if v == nil {
		return nil
	}
	return num(v) / d
}
func first(v any) M {
	a := array(v)
	if len(a) > 0 {
		return object(a[0])
	}
	return object(v)
}
func metric(key, label, unit string, value, sourceAt any, fetched, day, status string) M {
	if value != nil && num(value) < 0 {
		value = nil
		if status == "available" {
			status = "missing"
		}
	}
	if value != nil && (key == "sleep_hours" || key == "recovery_hours") {
		value = math.Round(num(value)*10) / 10
	}
	fresh := status == "available" && value != nil
	fetchedTime, fetchedErr := time.Parse(time.RFC3339, fetched)
	fresh = fresh && fetchedErr == nil && time.Since(fetchedTime) < time.Hour && time.Since(fetchedTime) > -time.Minute
	if sourceAt != nil {
		t, e := time.Parse(time.RFC3339, str(sourceAt))
		max := 3 * time.Hour
		if strings.HasPrefix(key, "sleep") || key == "hrv" {
			max = 32 * time.Hour
		}
		fresh = fresh && e == nil && time.Since(t) < max && time.Since(t) > -time.Hour
	} else {
		fresh = fresh && day == today()
	}
	return M{"key": key, "label": label, "unit": unit, "value": value, "source_at": sourceAt, "fetched_at": fetched, "status": status, "fresh": fresh, "data_date": day, "detail": "佳明设备日期 " + day}
}
func normalizeHealth(records M, day string) []any {
	out := []any{}
	add := func(source, key, label, unit string, value, at any) {
		r := object(records[source])
		status := str(r["status"])
		if value == nil && status == "available" {
			status = "missing"
		}
		out = append(out, metric(key, label, unit, value, at, str(r["fetched_at"]), str(r["data_date"]), status))
	}
	stats := field(records, "stats", "data")
	sleep := field(records, "sleep", "data", "dailySleepDTO")
	hrv := field(records, "hrv", "data", "hrvSummary")
	ready := first(field(records, "readiness", "data"))
	stress := field(records, "stress", "data")
	add("stats", "resting_hr", "静息心率", "bpm", field(stats, "restingHeartRate"), nil)
	add("stats", "steps", "步数", "步", field(stats, "totalSteps"), nil)
	add("sleep", "sleep_hours", "睡眠时长", "小时", divide(field(sleep, "sleepTimeSeconds"), 3600), timestamp(field(sleep, "sleepEndTimestampGMT")))
	add("sleep", "sleep_score", "睡眠评分", "/100", field(sleep, "sleepScores", "overall", "value"), timestamp(field(sleep, "sleepEndTimestampGMT")))
	add("hrv", "hrv", "夜间 HRV", "ms", field(hrv, "lastNightAvg"), nil)
	readyAt := timestamp(ready["timestampLocal"])
	if readyAt == nil && ready["timestamp"] != nil {
		s := str(ready["timestamp"])
		if len(s) >= 19 {
			readyAt = timestamp(s[:19] + "Z")
		}
	}
	add("readiness", "readiness", "训练准备度", "/100", ready["score"], readyAt)
	add("readiness", "recovery_hours", "恢复时间", "小时", divide(ready["recoveryTime"], 60), readyAt)
	add("stress", "stress", "平均压力", "/100", field(stress, "avgStressLevel"), nil)
	battery := first(field(records, "battery", "data"))
	var peak, current, batAt any
	values := array(battery["bodyBatteryValuesArray"])
	descriptors := array(battery["bodyBatteryValueDescriptorDTOList"])
	index, timeIndex := -1, -1
	for _, d := range descriptors {
		r := object(d)
		key := strings.ToLower(str(r["bodyBatteryValueDescriptorKey"]))
		if strings.Contains(key, "level") {
			index = int(num(r["bodyBatteryValueDescriptorIndex"]))
		}
		if strings.Contains(key, "timestamp") {
			timeIndex = int(num(r["bodyBatteryValueDescriptorIndex"]))
		}
	}
	if index >= 0 {
		for _, row := range values {
			a := array(row)
			if index < len(a) && a[index] != nil {
				current = a[index]
				if peak == nil || num(current) > num(peak) {
					peak = current
				}
				if timeIndex >= 0 && timeIndex < len(a) {
					batAt = timestamp(a[timeIndex])
				}
			}
		}
	}
	add("battery", "body_battery", "身体电量", "/100", current, batAt)
	add("battery", "body_battery_peak", "每日身体电量最高值", "/100", peak, nil)
	return out
}
func privateData(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := M{}
		for k, val := range x {
			l := strings.ToLower(k)
			if strings.Contains(l, "latitude") || strings.Contains(l, "longitude") || strings.Contains(l, "position_lat") || strings.Contains(l, "position_long") || strings.Contains(l, "polyline") || strings.Contains(l, "coordinates") || strings.HasPrefix(l, "owner") || strings.HasPrefix(l, "userprofile") || l == "displayname" || l == "fullname" || l == "firstname" || l == "lastname" || l == "email" || l == "deviceid" || l == "route_points" || l == "serialnumber" || l == "userid" || l == "userprofilepk" {
				continue
			}
			out[k] = privateData(val)
		}
		return out
	case []any:
		out := []any{}
		limit := len(x)
		if limit > 256 {
			limit = 256
		}
		for _, v := range x[:limit] {
			out = append(out, privateData(v))
		}
		if len(x) > limit {
			return M{"sample": out, "total_records": len(x), "omitted_records": len(x) - limit}
		}
		return out
	default:
		return v
	}
}
func (s *Server) Sync(ctx context.Context) error {
	profile, e := s.Garmin.Get(ctx, "/userprofile-service/socialProfile")
	if e != nil {
		health := object(s.Store.Get("health", M{}))
		health["sync_error"] = e.Error()
		health["connected"] = false
		plan := object(s.Store.Get("plan", EmptyPlan()))
		plan["status"] = "error"
		plan["sync_error"] = e.Error()
		_ = s.Store.PutMany(M{"health": health, "plan": plan})
		return e
	}
	display := str(object(profile)["displayName"])
	if display == "" {
		return fmt.Errorf("佳明未返回账号标识，无法同步身体数据")
	}
	at := now()
	daily := object(s.Store.Get("health_daily", M{}))
	day := today()
	for offset := 0; offset < 2; offset++ {
		date := time.Now().In(zone).AddDate(0, 0, -offset).Format("2006-01-02")
		records := object(daily[date])

		sources := []struct{ key, path string }{
			{"stats", "/usersummary-service/usersummary/daily/" + url.PathEscape(display) + "?calendarDate=" + date},
			{"sleep", "/wellness-service/wellness/dailySleepData/" + url.PathEscape(display) + "?date=" + date + "&nonSleepBufferMinutes=60"},
			{"hrv", "/hrv-service/hrv/" + date},
			{"readiness", "/metrics-service/metrics/trainingreadiness/" + date},
			{"stress", "/wellness-service/wellness/dailyStress/" + date},
			{"battery", "/wellness-service/wellness/bodyBattery/reports/daily?startDate=" + date + "&endDate=" + date},
			{"training", "/metrics-service/metrics/trainingstatus/aggregated/" + date},
			{"heart", "/wellness-service/wellness/dailyHeartRate/" + url.PathEscape(display) + "?date=" + date},
		}
		for _, src := range sources {

			if ctx.Err() != nil {
				return ctx.Err()
			}
			v, err := s.Garmin.Get(ctx, src.path)
			r := object(records[src.key])
			r["attempted_at"] = at
			r["requested_date"] = date
			if err != nil {
				r["status"] = "error"
				r["error"] = err.Error()
			} else {
				r["data"] = v
				r["fetched_at"] = now()
				r["data_date"] = sourceDay(v)
				r["status"] = "available"
				r["error"] = nil
			}
			records[src.key] = r
		}
		daily[date] = records
	}
	rawActivities, activityErr := s.Garmin.Get(ctx, "/activitylist-service/activities/search/activities?start=0&limit=60")
	activities := []any{}
	if activityErr == nil {
		for _, row := range array(rawActivities) {
			activities = append(activities, activity(object(row)))
		}
	} else {
		activities = array(object(s.Store.Get("health", M{}))["activities"])
	}
	oldPlan := object(s.Store.Get("plan", EmptyPlan()))
	plan, planErr := s.Garmin.Plan(ctx, oldPlan)
	if planErr != nil {
		plan = oldPlan
		plan["status"] = "error"
		plan["sync_error"] = planErr.Error()
	}
	health := M{"connected": true, "synced_at": now(), "sync_error": nil, "metrics": normalizeHealth(object(daily[day]), day), "activities": activities}
	if activityErr != nil {
		health["sync_error"] = activityErr.Error()
	}
	s.mu.Lock()
	e = s.Store.PutMany(M{"health": health, "health_daily": daily, "plan": plan})
	s.mu.Unlock()
	if e != nil {
		return e
	}
	// Prefetch only new activities. Details remain private and source dated.
	for i, a := range activities {
		if i >= 4 {
			break
		}
		aid := str(object(a)["id"])
		if s.Store.Get("activity:"+aid, nil) != nil {
			continue
		}
		_, _ = s.Activity(ctx, aid)
	}
	for i, a := range activities {
		if i >= 8 {
			break
		}
		m := object(a)
		aid := str(m["id"])
		if s.Store.Get("route:"+aid, nil) != nil {
			continue
		}
		raw, err := s.Garmin.Get(ctx, "/activity-service/activity/"+url.PathEscape(aid)+"/details?maxChartSize=100&maxPolylineSize=120")
		if err == nil {
			_ = s.Store.Put("route:"+aid, routeShape(raw))
		}
	}
	s.backfillHealth(ctx, display)
	return nil
}
func (s *Server) Activity(ctx context.Context, identifier string) (M, error) {
	allowed := false
	for _, a := range array(object(s.Store.Get("health", M{}))["activities"]) {
		if str(object(a)["id"]) == identifier {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, fmt.Errorf("只能查询当前账号已同步的活动")
	}
	if cached := s.Store.Get("activity:"+identifier, nil); cached != nil {
		return object(cached), nil
	}
	raw, e := s.Garmin.Get(ctx, "/activity-service/activity/"+url.PathEscape(identifier))
	if e != nil {
		return nil, e
	}
	result := M{"summary": raw, "fetched_at": now(), "source": "garmin"}
	for _, suffix := range []string{"splits", "hrTimeInZones", "powerTimeInZones", "exerciseSets"} {
		v, err := s.Garmin.Get(ctx, "/activity-service/activity/"+url.PathEscape(identifier)+"/"+suffix)
		if err != nil {
			result[suffix] = M{"status": "error", "error": err.Error()}
		} else {
			result[suffix] = v
		}
	}
	_ = s.Store.Put("activity:"+identifier, result)
	return result, nil
}
func (s *Server) VisualCatalog() M {
	daily := object(s.Store.Get("health_daily", M{}))
	dates := []string{}
	for d := range daily {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	if len(dates) > 30 {
		dates = dates[len(dates)-30:]
	}
	catalog := M{}
	for _, date := range dates {
		for _, v := range normalizeHealth(object(daily[date]), date) {
			m := object(v)
			key := str(m["key"])
			series := object(catalog[key])
			if len(series) == 0 {
				series = M{"key": key, "label": m["label"], "unit": m["unit"], "description": "佳明日级设备记录；读取时间不等于测量时间", "points": []any{}}
			}
			value, status := m["value"], m["status"]
			measured := dateOnly(m["source_at"])
			if measured == nil {
				measured = dateOnly(m["data_date"])
			}
			if measured != nil && str(measured) != date {
				value = nil
				status = "missing"
			}
			series["points"] = append(array(series["points"]), M{"date": date, "value": value, "status": status, "source_at": m["source_at"], "fetched_at": m["fetched_at"]})
			catalog[key] = series
		}
	}
	return catalog
}

func sourceDay(v any) any {
	m := first(v)
	for _, key := range []string{"calendarDate", "date"} {
		if d := dateOnly(m[key]); d != nil {
			return d
		}
	}
	for _, key := range []string{"hrvSummary", "dailySleepDTO"} {
		inner := object(m[key])
		if d := dateOnly(inner["calendarDate"]); d != nil {
			return d
		}
	}
	return nil
}

// Changes use dated, available observations, including real zero values.
func healthChanges(catalog M) []any {
	out := []any{}
	for _, key := range []string{"sleep_hours", "hrv", "readiness", "recovery_hours", "resting_hr", "acute_load"} {
		series := object(catalog[key])
		valid := []M{}
		for _, p := range array(series["points"]) {
			m := object(p)
			if m["value"] != nil && str(m["status"]) == "available" {
				valid = append(valid, m)
			}
		}
		if len(valid) == 0 {
			continue
		}
		latest := valid[len(valid)-1]
		change := M{"key": key, "label": series["label"], "unit": series["unit"], "current": latest["value"], "date": latest["date"], "previous": nil, "previous_date": nil, "delta": nil, "baseline_mean": nil, "baseline_days": 0}
		if len(valid) > 1 {
			prev := valid[len(valid)-2]
			change["previous"] = prev["value"]
			change["previous_date"] = prev["date"]
			change["delta"] = math.Round((num(latest["value"])-num(prev["value"]))*100) / 100
		}
		latestDate, _ := time.Parse("2006-01-02", str(latest["date"]))
		var sum float64
		count := 0
		for _, p := range valid[:len(valid)-1] {
			d, e := time.Parse("2006-01-02", str(p["date"]))
			if e == nil && !d.Before(latestDate.AddDate(0, 0, -7)) {
				sum += num(p["value"])
				count++
			}
		}
		if count > 0 {
			change["baseline_mean"] = math.Round(sum/float64(count)*100) / 100
			change["baseline_days"] = count
		}
		out = append(out, change)
	}
	return out
}

func routeShape(raw any) []any {
	points := array(field(raw, "geoPolylineDTO", "polyline"))
	coords := []M{}
	minX, maxX, minY, maxY := 180.0, -180.0, 90.0, -90.0
	for _, v := range points {
		p := object(v)
		if p["lat"] == nil || p["lon"] == nil {
			continue
		}
		lat, lon := num(p["lat"]), num(p["lon"])
		if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			continue
		}
		coords = append(coords, M{"x": lon, "y": lat})
		minX = math.Min(minX, lon)
		maxX = math.Max(maxX, lon)
		minY = math.Min(minY, lat)
		maxY = math.Max(maxY, lat)
	}
	if len(coords) < 2 {
		return []any{}
	}
	cos := math.Cos((minY + maxY) / 2 * math.Pi / 180)
	scale := math.Max((maxX-minX)*cos, maxY-minY)
	if scale == 0 {
		return []any{}
	}
	out := []any{}
	stride := 1
	if len(coords) > 160 {
		stride = (len(coords) + 159) / 160
	}
	for i, p := range coords {
		if i%stride != 0 && i != len(coords)-1 {
			continue
		}
		out = append(out, []any{math.Round((8+(num(p["x"])-minX)*cos/scale*84)*10) / 10, math.Round((92-(num(p["y"])-minY)/scale*84)*10) / 10})
	}
	return out
}

// A short, checkpointed backfill follows the already-persisted current snapshot.
func (s *Server) backfillHealth(parent context.Context, display string) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	daily := object(s.Store.Get("health_daily", M{}))
	datesDone := 0
	for offset := 2; offset < 30; offset++ {
		if ctx.Err() != nil || datesDone >= 5 {
			return
		}
		date := time.Now().In(zone).AddDate(0, 0, -offset).Format("2006-01-02")
		records := object(daily[date])
		changed := false
		sources := []struct{ key, path string }{{"stats", "/usersummary-service/usersummary/daily/" + url.PathEscape(display) + "?calendarDate=" + date}, {"sleep", "/wellness-service/wellness/dailySleepData/" + url.PathEscape(display) + "?date=" + date + "&nonSleepBufferMinutes=60"}, {"hrv", "/hrv-service/hrv/" + date}, {"readiness", "/metrics-service/metrics/trainingreadiness/" + date}, {"training", "/metrics-service/metrics/trainingstatus/aggregated/" + date}}
		for _, src := range sources {
			previous := object(records[src.key])
			if str(previous["status"]) == "available" || strings.HasPrefix(str(previous["attempted_at"]), today()) {
				continue
			}
			value, err := s.Garmin.Get(ctx, src.path)
			if ctx.Err() != nil {
				break
			}
			previous["attempted_at"] = now()
			previous["requested_date"] = date
			if err != nil {
				previous["status"] = "error"
				previous["error"] = err.Error()
			} else {
				previous["status"] = "available"
				previous["data"] = value
				previous["data_date"] = sourceDay(value)
				previous["fetched_at"] = now()
				previous["error"] = nil
			}
			records[src.key] = previous
			changed = true
		}
		if changed {
			daily[date] = records
			s.mu.Lock()
			_ = s.Store.Put("health_daily", daily)
			s.mu.Unlock()
			datesDone++
		}
	}
}
