# REA Studio: the back room (server) plus the phone app, in one box.
# Node 22 for REA, Java 21 for its Android tools, Python for the report script.
FROM node:22-bookworm-slim AS node

FROM eclipse-temurin:21-jdk-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && useradd --create-home rea \
 && mkdir -p /srv && chown rea:rea /srv

WORKDIR /srv
COPY --chown=rea:rea . .
USER rea
# Downloads REA and its two helper tools (checked against known fingerprints).
RUN bash scripts/setup.sh

ENV PORT=8080 DATA_DIR=/srv/app/data
EXPOSE 8080
CMD ["node", "app/server.js"]
