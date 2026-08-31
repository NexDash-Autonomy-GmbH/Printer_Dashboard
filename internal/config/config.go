package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type SMTP struct {
	Host      string
	Port      int
	User      string
	Password  string
	FromEmail string
	FromName  string
}

type Config struct {
	PrinterHost     string
	ScanDir         string
	Listen          string
	BridgeToken     string
	Emails          []string
	WorkspaceEmails []string
	SMTP            SMTP
	configPath      string
}

func Load() Config {
	loadDotEnv()
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".config", "xerox-scan", "config.json")
	emails := []string{}
	if raw, err := os.ReadFile(path); err == nil {
		var parsed struct {
			Emails []string `json:"emails"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			emails = parsed.Emails
		}
	}
	from := strings.ToLower(strings.TrimSpace(env("SMTP_FROM_EMAIL", env("SMTP_USER", ""))))
	port, _ := strconv.Atoi(env("SMTP_PORT", "587"))
	if port == 0 {
		port = 587
	}
	cfg := Config{
		PrinterHost: env("PRINTER_HOST", "192.168.68.52"),
		ScanDir:     env("SCAN_DIR", filepath.Join(home, "Documents", "Xerox-scans")),
		Listen:      env("API_LISTEN", ":8780"),
		BridgeToken: env("BRIDGE_TOKEN", "nexdash-printer"),
		SMTP: SMTP{
			Host:      env("SMTP_HOST", "smtp.gmail.com"),
			Port:      port,
			User:      env("SMTP_USER", ""),
			Password:  env("SMTP_PASSWORD", ""),
			FromEmail: from,
			FromName:  env("SMTP_FROM_NAME", from),
		},
		configPath: path,
	}
	if cfg.SMTP.FromName == "" {
		cfg.SMTP.FromName = cfg.SMTP.FromEmail
	}
	cfg.Emails = exclude(emails, from)
	cfg.WorkspaceEmails = workspace(from)
	return cfg
}

func (c *Config) SaveEmails(emails []string) error {
	c.Emails = exclude(emails, c.SMTP.FromEmail)
	dir := filepath.Dir(c.configPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(map[string]any{
		"emails":       c.Emails,
		"printer_host": c.PrinterHost,
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(c.configPath, append(body, '\n'), 0o600)
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func exclude(list []string, sender string) []string {
	out := make([]string, 0, len(list))
	seen := map[string]bool{}
	sender = strings.ToLower(sender)
	for _, e := range list {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" || e == sender || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return out
}

func workspace(sender string) []string {
	base := []string{
		"alwin@nexdash.com", "parth@nexdash.com", "esteban@nexdash.com",
		"elisa@nexdash.com", "franck@nexdash.com", "michael@nexdash.com",
		"karsten@nexdash.com", "gabriel@nexdash.com", "berit@nexdash.com",
	}
	for _, part := range strings.Split(env("WORKSPACE_EMAILS", ""), ",") {
		base = append(base, strings.TrimSpace(part))
	}
	return exclude(base, sender)
}

func loadDotEnv() {
	paths := []string{".env"}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".config", "xerox-scan", ".env"))
	}
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
				continue
			}
			k, v, _ := strings.Cut(line, "=")
			k = strings.TrimSpace(k)
			v = strings.Trim(strings.TrimSpace(v), `"'`)
			if k != "" && os.Getenv(k) == "" {
				_ = os.Setenv(k, v)
			}
		}
	}
}
