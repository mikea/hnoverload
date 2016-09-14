FROM node:4

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY . /usr/src/app
RUN npm install

CMD [ "npm", "start" ]

ENV PORT 8888
EXPOSE $PORT