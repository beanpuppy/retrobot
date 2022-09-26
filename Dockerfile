FROM alpine:3.16.2

WORKDIR /retrobot

RUN apk add --no-cache nodejs npm git

COPY . .

RUN npm i

CMD ["npm", "run", "start"]
