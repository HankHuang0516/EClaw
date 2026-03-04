FROM python:3.12-slim

# Install git (for repo clone) + Node.js (for Claude CLI npm package)
RUN apt-get update && apt-get install -y git curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir .
COPY . .

EXPOSE 4000
CMD ["python", "-m", "uvicorn", "proxy:app", "--host", "0.0.0.0", "--port", "4000"]
