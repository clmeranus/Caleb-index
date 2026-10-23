# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired (22.13 or newer, for the built-in SQLite module)
ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"

# The app has no npm dependencies, so there is nothing to install or compile.
COPY . .

# Run node directly (not through npm) so it receives the stop signal on deploys
# and can shut down cleanly.
EXPOSE 8080
CMD [ "node", "--disable-warning=ExperimentalWarning", "src/server.js" ]
