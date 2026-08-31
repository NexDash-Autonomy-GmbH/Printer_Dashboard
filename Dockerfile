FROM --platform=linux/amd64 golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /printer-api ./cmd/api

FROM --platform=linux/amd64 alpine:3.21
RUN apk add --no-cache ca-certificates \
	&& adduser -D -H -u 10001 app \
	&& mkdir -p /tmp/scans \
	&& chown app:app /tmp/scans
COPY --from=build /printer-api /printer-api
USER app
ENV API_LISTEN=:8780
ENV SCAN_DIR=/tmp/scans
ENV CONFIG_PATH=/tmp/config.json
EXPOSE 8780
CMD ["/printer-api"]
