package app

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

//go:embed prompts/coach.txt
var coachPrompt string

//go:embed prompts/reply.schema.json
var replySchema []byte

type Harness struct{ Dir string }

func Model() string {
	v := os.Getenv("COACH_MODEL")
	if v == "" {
		v = "deepseek-flash"
	}
	return v
}
func Provider() string {
	v := os.Getenv("COACH_PROVIDER")
	if v == "" {
		v = "deepseek-official"
	}
	return v
}
func (h Harness) Available() bool {
	bin := os.Getenv("HARNESS_BIN")
	if bin == "" {
		bin = "dsh"
	}
	_, e := exec.LookPath(bin)
	return e == nil && os.Getenv("DEEPSEEK_API_KEY") != ""
}
func (h Harness) Infer(ctx context.Context, input M) (M, error) {
	if !h.Available() {
		return nil, errors.New("教练尚未配置，请检查服务器模型凭证与运行时")
	}
	home, workspace := filepath.Join(h.Dir, "harness"), filepath.Join(h.Dir, "harness", "workspace")
	if e := os.MkdirAll(workspace, 0700); e != nil {
		return nil, e
	}
	bin := os.Getenv("HARNESS_BIN")
	if bin == "" {
		bin = "dsh"
	}
	patch := os.Getenv("HARNESS_PATCH")
	if patch == "" {
		patch = "config/coach.patch.yml"
	}
	patch, _ = filepath.Abs(patch)
	cmd := exec.CommandContext(ctx, bin, "--profile", "sdk-minimal", "--patch", patch)
	cmd.Dir = workspace
	cmd.Env = append(os.Environ(), "DSH_HOME="+home, "DSH_SYSTEM_PROMPT="+coachPrompt, "DSH_PRIMARY_RUNTIME=", "DSH_TELEMETRY=false")
	in, e := cmd.StdinPipe()
	if e != nil {
		return nil, e
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		return nil, e
	}
	cmd.Stderr = io.Discard
	if e = cmd.Start(); e != nil {
		return nil, errors.New("无法启动官方教练运行时")
	}
	defer func() {
		_ = in.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()
	encoder := json.NewEncoder(in)
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	send := func(n int, method string, params any) error {
		return encoder.Encode(M{"jsonrpc": "2.0", "id": n, "method": method, "params": params})
	}
	readReply := func(wanted int) error {
		for scanner.Scan() {
			frame := object(decode(scanner.Bytes()))
			if frame["method"] != nil && frame["id"] != nil {
				_ = encoder.Encode(M{"jsonrpc": "2.0", "id": frame["id"], "error": M{"code": -32601, "message": "Coach tools are disabled"}})
				continue
			}
			if int(num(frame["id"])) == wanted {
				if frame["error"] != nil {
					return errors.New("教练运行时拒绝请求，请检查模型与认证配置")
				}
				return nil
			}
		}
		return errors.New("教练运行时启动或连接中断")
	}
	if e = send(1, "initialize", M{"cwd": workspace, "provider": Provider(), "model": Model(), "reasoningEffort": "low", "maxTokens": 12288}); e != nil {
		return nil, e
	}
	if e = readReply(1); e != nil {
		return nil, e
	}
	input["response_schema"] = decode(replySchema)
	session := "heracles-" + id()
	if e = send(2, "session/prompt", M{"sessionId": session, "contentBlocks": []any{M{"type": "text", "text": "context=" + string(encode(input))}}}); e != nil {
		return nil, e
	}
	var final string
	received, completed := false, false
	for scanner.Scan() {
		frame := object(decode(scanner.Bytes()))
		method := str(frame["method"])
		params := object(frame["params"])
		if frame["id"] != nil && method != "" {
			_ = encoder.Encode(M{"jsonrpc": "2.0", "id": frame["id"], "error": M{"code": -32601, "message": "Coach tools are disabled"}})
			continue
		}
		if frame["error"] != nil {
			return nil, errors.New("教练运行时未完成请求")
		}
		if str(params["sessionId"]) != session {
			continue
		}
		if method == "session.event" {
			event := object(params["event"])
			data := object(event["data"])
			switch str(event["type"]) {
			case "agent/inbox/spliced":
				received = true
			case "assistant/message":
				message := object(data["message"])
				if len(message) == 0 {
					message = data
				}
				var b bytes.Buffer
				for _, block := range array(message["content"]) {
					m := object(block)
					if str(m["type"]) == "text" {
						b.WriteString(str(m["text"]))
					}
				}
				if b.Len() > 0 {
					final = b.String()
				}
			case "turn/end":
				completed = str(object(data["reason"])["kind"]) == "completed"
			}
		}
		if method == "session.status" && str(params["status"]) == "idle" && received {
			if !completed || !json.Valid([]byte(final)) {
				return nil, errors.New("教练没有返回完整的结构化回复")
			}
			reply := object(decode([]byte(final)))
			if !textLimit(str(reply["summary"]), 600) || len(array(reply["sections"])) > 4 || len(array(reply["tool_requests"])) > 3 {
				return nil, errors.New("教练回复不符合约定")
			}
			return reply, nil
		}
	}
	if ctx.Err() != nil {
		return nil, errors.New("教练分析超时，请稍后重试")
	}
	return nil, fmt.Errorf("教练运行时连接已结束")
}
