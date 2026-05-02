# Use the official Playwright image which already has Chromium and all OS deps installed.
# This avoids the `playwright install-deps` failure on Render (no sudo on free tier).
FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

WORKDIR /app

# Install Python dependencies first (Docker layer caching)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the scraper code
COPY . .

# Render injects PORT at runtime; default to 8000 for local docker run
ENV PORT=8000

# Use shell form so $PORT is expanded by the shell at container start
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
