FROM node:20-slim

# locales package + generate C.UTF-8 so Node + better-sqlite3 agree on UTF-8 string handling
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ locales && \
    sed -i 's/# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen || true && \
    rm -rf /var/lib/apt/lists/*

# Force UTF-8 locale for the whole container — without this, server-side string handling
# (better-sqlite3 bindings, String() coercion in some paths) can interpret Hebrew as Latin-1,
# causing the DB to store each UTF-8 byte as a separate Latin-1 character.
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV LANGUAGE=C.UTF-8

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
