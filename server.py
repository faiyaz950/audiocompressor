"""Local dev server with COOP/COEP headers required by FFmpeg WASM."""
import http.server, webbrowser, sys

PORT = 8765

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep terminal quiet

if __name__ == "__main__":
    with http.server.HTTPServer(("", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"AudioShrink running at {url}")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
