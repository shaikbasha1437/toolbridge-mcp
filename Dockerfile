# ToolBridge MCP: Streamable HTTP server in a container.
# Note: this Dockerfile was written but NOT built or run during development (no container runtime was available).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY core ./core
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
ENV TOOLBRIDGE_DATA_DIR=/data
EXPOSE 8787
# Tokens come from the environment, e.g. -e TOOLBRIDGE_TOKENS="agent:$(openssl rand -hex 24)".
# Binding 0.0.0.0 inside the container is required for port publishing; publish it on 127.0.0.1 only:
#   docker run --rm -p 127.0.0.1:8787:8787 -e TOOLBRIDGE_TOKENS=agent:... toolbridge-mcp
# Host-header checks still apply: only localhost/127.0.0.1 Host values are accepted unless you add --allow-host.
CMD ["node", "bin/toolbridge-mcp.js", "http", "--host", "0.0.0.0", "--port", "8787"]
