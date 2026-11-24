# Build from the repository root so npm ci uses the workspace lockfile. The CLI does this through compose.yaml.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY workers/request-desk/package.json workers/request-desk/
RUN npm ci --omit=dev --ignore-scripts -w request-desk
COPY workers/request-desk/input.mjs workers/request-desk/
COPY workers/request-desk/src workers/request-desk/src
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const response = await fetch('http://127.0.0.1:' + process.env.PORT + '/health'); process.exit(response.ok ? 0 : 1)"
CMD ["node", "workers/request-desk/src/worker.mjs"]
