FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
ARG GIT_SHA=dev
RUN echo "$GIT_SHA" > /usr/share/nginx/html/version.txt
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1/version.txt || exit 1
