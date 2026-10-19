/*
 * P5 Manager console agent — first protocol spike.
 *
 * The first version deliberately exposes only a health endpoint. Keep the
 * network surface small until request authentication and the Android pairing
 * flow are implemented; do not add file or account operations unauthenticated.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef AGENT_PORT
#define AGENT_PORT 9831
#endif

#define REQUEST_CAPACITY 4096
#define RESPONSE_CAPACITY 512

int sceNetInit(void);
int sceNetPoolCreate(const char *name, int size, int flags);

static int send_all(int fd, const char *data, size_t length) {
  size_t sent = 0;
  while (sent < length) {
    const ssize_t count = send(fd, data + sent, length - sent, 0);
    if (count <= 0) return -1;
    sent += (size_t)count;
  }
  return 0;
}

static void respond(int fd, int status, const char *reason, const char *body) {
  char response[RESPONSE_CAPACITY];
  const size_t body_length = status == 204 ? 0 : strlen(body);
  const int header_length = snprintf(response, sizeof(response),
      "HTTP/1.1 %d %s\r\n"
      "Content-Type: application/json; charset=utf-8\r\n"
      "Content-Length: %zu\r\n"
      "Cache-Control: no-store\r\n"
      "Access-Control-Allow-Origin: *\r\n"
      "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
      "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
      "Connection: close\r\n\r\n",
      status, reason, body_length);

  if (header_length <= 0 || (size_t)header_length >= sizeof(response)) return;
  (void)send_all(fd, response, (size_t)header_length);
  if (body_length) (void)send_all(fd, body, body_length);
}

static void handle_client(int fd) {
  char request[REQUEST_CAPACITY] = {0};
  size_t used = 0;
  struct timeval timeout = {.tv_sec = 3, .tv_usec = 0};
  (void)setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

  while (used + 1 < sizeof(request)) {
    const ssize_t count = recv(fd, request + used, sizeof(request) - used - 1, 0);
    if (count <= 0) break;
    used += (size_t)count;
    request[used] = '\0';
    if (strstr(request, "\r\n\r\n")) break;
  }

  char method[8] = {0};
  char path[128] = {0};
  if (sscanf(request, "%7s %127s", method, path) != 2) {
    respond(fd, 400, "Bad Request", "{\"error\":\"Invalid HTTP request\"}");
  } else if (strcmp(method, "OPTIONS") == 0) {
    respond(fd, 204, "No Content", "{}");
  } else if (strcmp(method, "GET") == 0 &&
             (strcmp(path, "/health") == 0 || strcmp(path, "/api/health") == 0)) {
    respond(fd, 200, "OK", "{\"status\":\"ok\",\"agent\":\"p5managerd\",\"api_version\":1}");
  } else {
    respond(fd, 404, "Not Found", "{\"error\":\"Endpoint not available\"}");
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  if (sceNetInit() != 0) {
    fprintf(stderr, "p5managerd: sceNetInit failed\n");
    return 1;
  }
  if (sceNetPoolCreate("p5managerd", 256 * 1024, 0) < 0) {
    fprintf(stderr, "p5managerd: sceNetPoolCreate failed\n");
    return 1;
  }

  const int server = socket(AF_INET, SOCK_STREAM, 0);
  if (server < 0) {
    perror("p5managerd: socket");
    return 1;
  }

  int reuse = 1;
  (void)setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  struct sockaddr_in address = {0};
  address.sin_len = sizeof(address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(AGENT_PORT);

  if (bind(server, (struct sockaddr *)&address, sizeof(address)) < 0) {
    perror("p5managerd: bind");
    close(server);
    return 1;
  }
  if (listen(server, 8) < 0) {
    perror("p5managerd: listen");
    close(server);
    return 1;
  }

  printf("P5 Manager agent listening on port %d\n", AGENT_PORT);
  for (;;) {
    const int client = accept(server, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      perror("p5managerd: accept");
      sleep(1);
      continue;
    }
    handle_client(client);
    close(client);
  }
}
