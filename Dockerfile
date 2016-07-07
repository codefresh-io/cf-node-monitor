FROM node:6.3.0-slim

ENV SHELL /bin/bash
COPY *.js package.json cf-node-monitor/

WORKDIR /cf-node-monitor
RUN npm install

EXPOSE 3999

CMD npm start