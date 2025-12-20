import os
import json
from http.server import BaseHTTPRequestHandler
import requests

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # читаем тело запроса
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length or 0)
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"invalid json"}')
            return

        message = data.get("message", "")

        if not GROQ_API_KEY:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"error":"GROQ_API_KEY not set"}')
            return

        headers = {
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "llama-3.3-70b-versatile",
            "messages": [
                {"role": "user", "content": message},
            ],
            "max_tokens": 256,
        }

        resp = requests.post(GROQ_API_URL, headers=headers, data=json.dumps(payload), timeout=30)
        try:
            groq_json = resp.json()
            reply = groq_json["choices"][0]["message"]["content"]
        except Exception:
            self.send_response(500)
            self.end_headers()
            out = json.dumps({"error": "groq_failed", "body": resp.text[:500]}).encode("utf-8")
            self.wfile.write(out)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        out = json.dumps({"reply": reply}).encode("utf-8")
        self.wfile.write(out)
