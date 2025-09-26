# build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
# install with npm by default
RUN if [ -f package-lock.json ]; then npm ci;     elif [ -f yarn.lock ]; then yarn install --frozen-lockfile;     elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm i --frozen-lockfile;     else npm i; fi
COPY . .
RUN npm run build || (yarn build || (corepack enable && pnpm build))

# serve
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
