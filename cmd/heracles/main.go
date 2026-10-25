package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/hx-w/heracles/internal/app"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	dir := os.Getenv("HERACLES_DATA_DIR")
	if dir == "" {
		dir = ".local/go"
	}
	web := os.Getenv("HERACLES_WEB_DIR")
	if web == "" {
		web = "web/dist"
	}
	if len(os.Args) > 1 && os.Args[1] == "access" {
		f := flag.NewFlagSet("access", flag.ExitOnError)
		origin := f.String("url", "", "Public HTTPS origin")
		revoke := f.Bool("revoke-all", false, "Revoke all devices and unused invites")
		_ = f.Parse(os.Args[2:])
		store, e := app.OpenStore(dir)
		if e != nil {
			log.Fatal("Cannot open private store")
		}
		defer store.Close()
		if *revoke {
			if e = store.RevokeAll(); e != nil {
				log.Fatal("Revocation failed")
			}
			fmt.Println("All devices and unused invitations revoked")
			return
		}
		if e = app.ValidateOrigin(*origin); e != nil {
			log.Fatal(e)
		}
		token, e := store.Invite()
		if e != nil {
			log.Fatal("Cannot create invitation")
		}
		fmt.Println(strings.TrimRight(*origin, "/") + "/?access=" + token)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := http.Client{Timeout: 3 * time.Second}
		r, e := client.Get("http://127.0.0.1:8791/healthz")
		if e != nil || r.StatusCode != 200 {
			os.Exit(1)
		}
		r.Body.Close()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "garmin-import" {
		f := flag.NewFlagSet("garmin-import", flag.ExitOnError)
		source := f.String("file", "", "Path to own Garmin DI credential JSON")
		_ = f.Parse(os.Args[2:])
		if *source == "" {
			log.Fatal("--file is required")
		}
		b, e := os.ReadFile(*source)
		if e != nil {
			log.Fatal("Cannot read credential file")
		}
		if e = os.MkdirAll(dir, 0700); e != nil {
			log.Fatal("Cannot create private directory")
		}
		dest := filepath.Join(dir, "garmin_tokens.json")
		if e = os.WriteFile(dest, b, 0600); e != nil {
			log.Fatal("Cannot save credential")
		}
		fmt.Println("Garmin credential imported. It will refresh automatically.")
		return
	}
	server, e := app.New(dir, web)
	if e != nil {
		log.Fatal("Cannot initialize Heracles store")
	}
	defer server.Store.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server.RunBackground(ctx)
	addr := os.Getenv("HERACLES_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8791"
	}
	httpServer := &http.Server{Addr: addr, Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 * 1024}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		c, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		if e := httpServer.Shutdown(c); e != nil {
			_ = httpServer.Close()
		}
	}()
	log.Printf("Heracles listening on %s", addr)
	if e = httpServer.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
	cancel()
	<-shutdownDone
	server.Wait()
}
