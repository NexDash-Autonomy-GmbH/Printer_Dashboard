package mail

import (
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"

	"printer-dashboard/internal/config"
)

func Send(cfg config.SMTP, to []string, subject, body string, pdf []byte, filename string) error {
	if cfg.User == "" || cfg.Password == "" || cfg.FromEmail == "" {
		return fmt.Errorf("SMTP_USER, SMTP_PASSWORD and SMTP_FROM_EMAIL must be set in .env")
	}
	boundary := "nexdashprinterboundary"
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s <%s>\r\n", cfg.FromName, cfg.FromEmail)
	fmt.Fprintf(&b, "To: %s\r\n", strings.Join(to, ", "))
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&b, "Content-Type: multipart/mixed; boundary=%s\r\n\r\n", boundary)
	fmt.Fprintf(&b, "--%s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n", boundary, body)
	fmt.Fprintf(&b, "--%s\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"%s\"\r\nContent-Transfer-Encoding: base64\r\n\r\n", boundary, filename)
	b.WriteString(base64.StdEncoding.EncodeToString(pdf))
	fmt.Fprintf(&b, "\r\n--%s--\r\n", boundary)

	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	conn, err := net.DialTimeout("tcp", addr, 20*time.Second)
	if err != nil {
		return err
	}
	c, err := smtp.NewClient(conn, cfg.Host)
	if err != nil {
		return err
	}
	defer c.Close()
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: cfg.Host}); err != nil {
			return err
		}
	}
	auth := smtp.PlainAuth("", cfg.User, cfg.Password, cfg.Host)
	if err := c.Auth(auth); err != nil {
		return fmt.Errorf("SMTP login failed. Use a Google App Password for %s: %w", cfg.User, err)
	}
	if err := c.Mail(cfg.FromEmail); err != nil {
		return err
	}
	for _, rcpt := range to {
		if err := c.Rcpt(rcpt); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte(b.String())); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}
