FROM nginx
RUN apt-get update && apt-get install openssh-server -y && rm -rf /var/cache/apt/archives /var/lib/apt/lists/*
COPY ./public/ /usr/share/nginx/html

