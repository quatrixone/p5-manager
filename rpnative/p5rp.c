// SPDX-License-Identifier: AGPL-3.0-only
//
// p5rp - Remote Play session helper for P5 Manager, built on libchiaki
// (chiaki-ng, AGPL-3.0). One process holds one session with a console.
//
//   p5rp --host <ip> [--ps4] [--res 360|540|720|1080] [--fps 30|60]
//        [--bitrate <kbit/s>] [--codec h264|h265] [--audio]
//   p5rp regist --host <ip> [--ps4] [--target <n>] [--broadcast]
//
// The pairing keys come in the environment, not on the command line, where
// every user of the machine could read them:
//   P5RP_REGIST_KEY   the console's regist key (up to 16 characters)
//   P5RP_MORNING      32 hex characters
//
// regist pairs with a console that shows its "link device" PIN. It takes
//   P5RP_ACCOUNT_ID   the PSN account id, 8 bytes in base64 or as a decimal
//   P5RP_PIN          the 8 digits on the console's screen
// and writes one JSON line to stdout: {"ok":true,"regist_key":<hex>,
// "rp_key":<hex>,"rp_key_type":n,"mac":<hex>,"nickname":...,"target":n},
// or {"ok":false,"error":...}; why it failed is in the log lines on stderr,
// which come as for a session.
//
// stdout  the video, as the console encoded it (Annex B), one record a frame:
//           'V'  flags(1)  length(4, big endian)  time(8, big endian, us)  data
//         flags: 1 = key frame, 2 = frames were lost before it, 4 = repaired by FEC
//         With --audio, the sound too, in records of the same shape: 'A' for
//         one Opus packet as the console sent it, and before the first of
//         them 'H' with the format as text ("channels rate frame_size").
// stderr  one JSON object a line: {"event":"connected"}, {"event":"quit",...},
//         {"event":"stats",...}, {"event":"log",...}
// stdin   one command a line:
//           btn <name> <0|1>      cross moon box pyramid left right up down
//                                 l1 r1 l3 r3 options share touchpad ps
//           trigger <l2|r2> <0..255>
//           stick <l|r> <x> <y>   -32768..32767
//           touch down <x> <y>    a finger on the touchpad (0..1919, 0..941)
//           touch move <x> <y>
//           touch up
//           idr                   ask the console for a key frame (a viewer
//                                 that joins late needs one to start from)
//           motion <gx> <gy> <gz> <ax> <ay> <az>
//                                 the controller's gyro (rad/s) and
//                                 accelerometer (g; at rest 0 1 0)
//           idle                  everything released
//           standby               put the console into rest mode
//           stop                  end the session
//         End of input ends the session too: the helper never outlives the
//         program that started it.
#include <chiaki/common.h>
#include <chiaki/controller.h>
#include <chiaki/base64.h>
#include <chiaki/log.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <pthread.h>
#include <unistd.h>
#endif

static ChiakiSession session;
static ChiakiControllerState controller;
static volatile int quit_seen = 0;
static uint64_t frames = 0, frames_lost = 0, frames_repaired = 0, bytes_out = 0;

#ifdef _WIN32
static CRITICAL_SECTION out_lock, err_lock;
#define LOCK(l) EnterCriticalSection(&(l))
#define UNLOCK(l) LeaveCriticalSection(&(l))
static uint64_t now_us(void) { LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (uint64_t)(c.QuadPart * 1000000.0 / f.QuadPart); }
static void sleep_ms(unsigned ms) { Sleep(ms); }
#else
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER, err_lock = PTHREAD_MUTEX_INITIALIZER;
#define LOCK(l) pthread_mutex_lock(&(l))
#define UNLOCK(l) pthread_mutex_unlock(&(l))
static uint64_t now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000u + (uint64_t)t.tv_nsec / 1000u; }
static void sleep_ms(unsigned ms) { usleep(ms * 1000u); }
#endif

// A JSON line on stderr. `text`, when given, is added as a string, escaped.
static void event_line(const char *text_key, const char *text, const char *fmt, ...)
{
	char head[512];
	va_list ap; va_start(ap, fmt); vsnprintf(head, sizeof head, fmt, ap); va_end(ap);
	LOCK(err_lock);
	fputs(head, stderr);
	if(text_key)
	{
		fprintf(stderr, ",\"%s\":\"", text_key);
		for(const unsigned char *p = (const unsigned char *)(text ? text : ""); *p; p++)
		{
			if(*p == '"' || *p == '\\') { fputc('\\', stderr); fputc(*p, stderr); }
			else if(*p < 0x20) fprintf(stderr, "\\u%04x", *p);
			else fputc(*p, stderr);
		}
		fputc('"', stderr);
	}
	fputs("}\n", stderr);
	fflush(stderr);
	UNLOCK(err_lock);
}

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	const char *name = level == CHIAKI_LOG_ERROR ? "error" : level == CHIAKI_LOG_WARNING ? "warning" : "info";
	event_line("msg", msg, "{\"event\":\"log\",\"level\":\"%s\"", name);
}

// Annex B: is there an IDR slice (H.264 type 5) or an IRAP picture (H.265 types 16..21)?
static int is_key_frame(const uint8_t *b, size_t n, int h265)
{
	for(size_t i = 0; i + 4 < n; i++)
	{
		if(b[i] != 0 || b[i + 1] != 0) continue;
		size_t s = 0;
		if(b[i + 2] == 1) s = i + 3;
		else if(b[i + 2] == 0 && b[i + 3] == 1) s = i + 4;
		if(!s || s >= n) continue;
		if(h265) { int t = (b[s] >> 1) & 0x3f; if(t >= 16 && t <= 21) return 1; }
		else if((b[s] & 0x1f) == 5) return 1;
		i = s;
	}
	return 0;
}

static int codec_h265 = 0;

// The console sends the decoder's parameter sets (SPS and PPS, for H.265 the
// VPS too) once, as a record of their own ahead of the first frame. Key
// frames come without them - and a viewer who joins later cannot start. So
// they are kept, and put in front of every key frame that lacks them.
static uint8_t params[4096];
static size_t params_len = 0;

// Length of the leading run of parameter-set NAL units in an Annex B frame.
static size_t leading_params(const uint8_t *b, size_t n, int h265)
{
	size_t i = 0, end = 0;
	while(i + 4 < n)
	{
		size_t s = 0;
		if(b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1) s = i + 3;
		else if(b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 0 && b[i + 3] == 1) s = i + 4;
		if(!s) { i++; continue; }
		int t = h265 ? (b[s] >> 1) & 0x3f : b[s] & 0x1f;
		int is_param = h265 ? (t >= 32 && t <= 34) : (t == 7 || t == 8);
		if(!is_param) return i > end ? i : end;
		end = s;
		i = s;
		// Up to the next start code belongs to this parameter set.
		while(i + 3 < n && !(b[i] == 0 && b[i + 1] == 0 && (b[i + 2] == 1 || (b[i + 2] == 0 && b[i + 3] == 1)))) i++;
		if(i + 3 >= n) return n; // nothing but parameter sets, which is how the console sends them
		end = i;
	}
	return end;
}

static bool video_cb(uint8_t *buf, size_t size, int32_t lost, bool recovered, void *user)
{
	(void)user;
	uint8_t head[14];
	uint64_t t = now_us();
	int key = is_key_frame(buf, size, codec_h265);
	size_t own = leading_params(buf, size, codec_h265);
	if(own > 0 && own <= sizeof params) { memcpy(params, buf, own); params_len = own; }
	size_t prefix = (key && own == 0) ? params_len : 0;
	size_t total = prefix + size;
	head[0] = 'V';
	head[1] = (uint8_t)((key ? 1 : 0) | (lost > 0 ? 2 : 0) | (recovered ? 4 : 0));
	head[2] = (uint8_t)(total >> 24); head[3] = (uint8_t)(total >> 16); head[4] = (uint8_t)(total >> 8); head[5] = (uint8_t)total;
	for(int i = 0; i < 8; i++) head[6 + i] = (uint8_t)(t >> (56 - 8 * i));
	LOCK(out_lock);
	fwrite(head, 1, sizeof head, stdout);
	if(prefix) fwrite(params, 1, prefix, stdout);
	fwrite(buf, 1, size, stdout);
	fflush(stdout);
	frames++; bytes_out += size;
	if(lost > 0) frames_lost += (uint64_t)lost;
	if(recovered) frames_repaired++;
	UNLOCK(out_lock);
	return true;
}

static void record(char kind, uint8_t flags, const uint8_t *buf, size_t size)
{
	uint8_t head[14];
	uint64_t t = now_us();
	head[0] = (uint8_t)kind;
	head[1] = flags;
	head[2] = (uint8_t)(size >> 24); head[3] = (uint8_t)(size >> 16); head[4] = (uint8_t)(size >> 8); head[5] = (uint8_t)size;
	for(int i = 0; i < 8; i++) head[6 + i] = (uint8_t)(t >> (56 - 8 * i));
	LOCK(out_lock);
	fwrite(head, 1, sizeof head, stdout);
	fwrite(buf, 1, size, stdout);
	fflush(stdout);
	UNLOCK(out_lock);
}

static void audio_header_cb(ChiakiAudioHeader *header, void *user)
{
	(void)user;
	char text[64];
	int n = snprintf(text, sizeof text, "%u %u %u", (unsigned)header->channels, (unsigned)header->rate, (unsigned)header->frame_size);
	record('H', 0, (const uint8_t *)text, (size_t)n);
	event_line(NULL, NULL, "{\"event\":\"audio\",\"channels\":%u,\"rate\":%u,\"frame_size\":%u",
		(unsigned)header->channels, (unsigned)header->rate, (unsigned)header->frame_size);
}

static void audio_frame_cb(uint8_t *buf, size_t size, void *user)
{
	(void)user;
	record('A', 0, buf, size);
}

static void event_cb(ChiakiEvent *event, void *user)
{
	(void)user;
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
			event_line(NULL, NULL, "{\"event\":\"connected\"");
			break;
		case CHIAKI_EVENT_QUIT:
			event_line("detail", event->quit.reason_str,
				"{\"event\":\"quit\",\"code\":%d,\"error\":%s,\"reason\":\"%s\"",
				(int)event->quit.reason, chiaki_quit_reason_is_error(event->quit.reason) ? "true" : "false",
				chiaki_quit_reason_string(event->quit.reason));
			quit_seen = 1;
			break;
		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
			event_line(NULL, NULL, "{\"event\":\"login_pin_request\",\"incorrect\":%s", event->login_pin_request.pin_incorrect ? "true" : "false");
			break;
		case CHIAKI_EVENT_VIDEO_FEC_FAILURE:
			event_line(NULL, NULL, "{\"event\":\"fec_failure\"");
			break;
		default:
			break;
	}
}

static const struct { const char *name; uint32_t bit; } BUTTONS[] = {
	{ "cross", CHIAKI_CONTROLLER_BUTTON_CROSS }, { "moon", CHIAKI_CONTROLLER_BUTTON_MOON }, { "circle", CHIAKI_CONTROLLER_BUTTON_MOON },
	{ "box", CHIAKI_CONTROLLER_BUTTON_BOX }, { "square", CHIAKI_CONTROLLER_BUTTON_BOX },
	{ "pyramid", CHIAKI_CONTROLLER_BUTTON_PYRAMID }, { "triangle", CHIAKI_CONTROLLER_BUTTON_PYRAMID },
	{ "left", CHIAKI_CONTROLLER_BUTTON_DPAD_LEFT }, { "right", CHIAKI_CONTROLLER_BUTTON_DPAD_RIGHT },
	{ "up", CHIAKI_CONTROLLER_BUTTON_DPAD_UP }, { "down", CHIAKI_CONTROLLER_BUTTON_DPAD_DOWN },
	{ "l1", CHIAKI_CONTROLLER_BUTTON_L1 }, { "r1", CHIAKI_CONTROLLER_BUTTON_R1 },
	{ "l3", CHIAKI_CONTROLLER_BUTTON_L3 }, { "r3", CHIAKI_CONTROLLER_BUTTON_R3 },
	{ "options", CHIAKI_CONTROLLER_BUTTON_OPTIONS }, { "share", CHIAKI_CONTROLLER_BUTTON_SHARE },
	{ "touchpad", CHIAKI_CONTROLLER_BUTTON_TOUCHPAD }, { "ps", CHIAKI_CONTROLLER_BUTTON_PS },
};

static int clamp(long v, long lo, long hi) { return (int)(v < lo ? lo : v > hi ? hi : v); }

// Returns 0 to go on, 1 when the session should end.
static int command(char *line)
{
	char a[32] = "", b[32] = "";
	long x = 0, y = 0;
	int n = sscanf(line, "%31s %31s %ld %ld", a, b, &x, &y);
	if(n < 1) return 0;
	if(!strcmp(a, "stop")) return 1;
	if(!strcmp(a, "standby")) { chiaki_session_goto_bed(&session); return 0; }
	if(!strcmp(a, "idr")) { chiaki_session_request_idr(&session); return 0; }
	if(!strcmp(a, "idle")) chiaki_controller_state_set_idle(&controller);
	else if(!strcmp(a, "motion"))
	{
		float g[3], ac[3];
		if(sscanf(line, "%*s %f %f %f %f %f %f", &g[0], &g[1], &g[2], &ac[0], &ac[1], &ac[2]) != 6)
		{
			event_line("command", line, "{\"event\":\"error\",\"what\":\"motion needs six numbers\"");
			return 0;
		}
		controller.gyro_x = g[0]; controller.gyro_y = g[1]; controller.gyro_z = g[2];
		controller.accel_x = ac[0]; controller.accel_y = ac[1]; controller.accel_z = ac[2];
	}
	else if(!strcmp(a, "btn") && n >= 3)
	{
		uint32_t bit = 0;
		for(size_t i = 0; i < sizeof BUTTONS / sizeof BUTTONS[0]; i++) if(!strcmp(b, BUTTONS[i].name)) bit = BUTTONS[i].bit;
		if(!bit) { event_line("command", line, "{\"event\":\"error\",\"what\":\"unknown button\""); return 0; }
		if(x) controller.buttons |= bit; else controller.buttons &= ~bit;
	}
	else if(!strcmp(a, "trigger") && n >= 3)
	{
		if(!strcmp(b, "l2")) controller.l2_state = (uint8_t)clamp(x, 0, 255);
		else if(!strcmp(b, "r2")) controller.r2_state = (uint8_t)clamp(x, 0, 255);
	}
	else if(!strcmp(a, "stick") && n >= 4)
	{
		if(b[0] == 'l') { controller.left_x = (int16_t)clamp(x, -32768, 32767); controller.left_y = (int16_t)clamp(y, -32768, 32767); }
		else { controller.right_x = (int16_t)clamp(x, -32768, 32767); controller.right_y = (int16_t)clamp(y, -32768, 32767); }
	}
	else if(!strcmp(a, "touch"))
	{
		static int touch_id = -1;
		uint16_t tx = (uint16_t)clamp(x, 0, 1919), ty = (uint16_t)clamp(y, 0, 941);
		if(!strcmp(b, "down") && n >= 4)
		{
			if(touch_id >= 0) chiaki_controller_state_stop_touch(&controller, (uint8_t)touch_id);
			touch_id = chiaki_controller_state_start_touch(&controller, tx, ty);
		}
		else if(!strcmp(b, "move") && n >= 4 && touch_id >= 0) chiaki_controller_state_set_touch_pos(&controller, (uint8_t)touch_id, tx, ty);
		else if(!strcmp(b, "up") && touch_id >= 0) { chiaki_controller_state_stop_touch(&controller, (uint8_t)touch_id); touch_id = -1; }
	}
	else { event_line("command", line, "{\"event\":\"error\",\"what\":\"unknown command\""); return 0; }
	chiaki_session_set_controller_state(&session, &controller);
	return 0;
}

static volatile int stop_requested = 0;

#ifdef _WIN32
static DWORD WINAPI stdin_thread(LPVOID arg)
#else
static void *stdin_thread(void *arg)
#endif
{
	(void)arg;
	char line[256];
	while(fgets(line, sizeof line, stdin))
	{
		line[strcspn(line, "\r\n")] = 0;
		if(command(line)) break;
	}
	stop_requested = 1;
	return 0;
}

static const char *arg_value(int argc, char **argv, const char *name, const char *fallback)
{
	for(int i = 1; i + 1 < argc; i++) if(!strcmp(argv[i], name)) return argv[i + 1];
	return fallback;
}
static int arg_flag(int argc, char **argv, const char *name)
{
	for(int i = 1; i < argc; i++) if(!strcmp(argv[i], name)) return 1;
	return 0;
}

// ── regist ───────────────────────────────────────────────────────────────

static volatile int regist_done = 0;

static void hex_out(const uint8_t *b, size_t n, char *out)
{
	static const char digits[] = "0123456789abcdef";
	for(size_t i = 0; i < n; i++) { out[2 * i] = digits[b[i] >> 4]; out[2 * i + 1] = digits[b[i] & 15]; }
	out[2 * n] = 0;
}

static void regist_cb(ChiakiRegistEvent *event, void *user)
{
	(void)user;
	if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && event->registered_host)
	{
		ChiakiRegisteredHost *h = event->registered_host;
		// The regist key comes padded with zeros to its full size.
		size_t key_len = 0;
		while(key_len < sizeof h->rp_regist_key && h->rp_regist_key[key_len]) key_len++;
		char regist_key[2 * sizeof h->rp_regist_key + 1], rp_key[2 * sizeof h->rp_key + 1], mac[2 * sizeof h->server_mac + 1];
		char nickname[sizeof h->server_nickname + 1];
		hex_out((const uint8_t *)h->rp_regist_key, key_len, regist_key);
		hex_out(h->rp_key, sizeof h->rp_key, rp_key);
		hex_out(h->server_mac, sizeof h->server_mac, mac);
		memcpy(nickname, h->server_nickname, sizeof h->server_nickname);
		nickname[sizeof h->server_nickname] = 0;
		LOCK(out_lock);
		printf("{\"ok\":true,\"regist_key\":\"%s\",\"rp_key\":\"%s\",\"rp_key_type\":%u,\"mac\":\"%s\",\"target\":%d,\"nickname\":\"",
			regist_key, rp_key, (unsigned)h->rp_key_type, mac, (int)h->target);
		for(const unsigned char *p = (const unsigned char *)nickname; *p; p++)
		{
			if(*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
			else if(*p >= 0x20) putchar(*p);
		}
		printf("\"}\n");
		fflush(stdout);
		UNLOCK(out_lock);
	}
	else
	{
		LOCK(out_lock);
		printf("{\"ok\":false,\"error\":\"%s\"}\n", event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_CANCELED
			? "canceled" : "failed");
		fflush(stdout);
		UNLOCK(out_lock);
	}
	regist_done = 1;
}

// The account id: 8 bytes, given in base64 (as PSN's Remote Play id) or as
// the decimal number PSN reports, which is stored little endian.
static int parse_account_id(const char *s, uint8_t out[8])
{
	size_t n = strlen(s), i;
	for(i = 0; i < n && s[i] >= '0' && s[i] <= '9'; i++);
	if(n > 0 && i == n)
	{
		unsigned long long v = strtoull(s, NULL, 10);
		for(int k = 0; k < 8; k++) out[k] = (uint8_t)(v >> (8 * k));
		return 1;
	}
	size_t len = 8;
	return chiaki_base64_decode(s, n, out, &len) == CHIAKI_ERR_SUCCESS && len == 8;
}

static int regist_main(int argc, char **argv)
{
	const char *host = arg_value(argc, argv, "--host", NULL);
	const char *account = getenv("P5RP_ACCOUNT_ID");
	const char *pin = getenv("P5RP_PIN");
	ChiakiRegistInfo info;
	memset(&info, 0, sizeof info);
	if(!host || !account || !pin || strlen(pin) != 8 || !parse_account_id(account, info.psn_account_id))
	{
		fprintf(stderr, "usage: p5rp regist --host <ip> [--ps4] [--target n] [--broadcast]\n"
			"with P5RP_ACCOUNT_ID (base64 or decimal) and P5RP_PIN (8 digits) in the environment\n");
		return 2;
	}
	if(chiaki_lib_init() != CHIAKI_ERR_SUCCESS) { printf("{\"ok\":false,\"error\":\"library init failed\"}\n"); return 1; }
	ChiakiLog log;
	chiaki_log_init(&log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, log_cb, NULL);
	int ps4 = arg_flag(argc, argv, "--ps4");
	info.target = (ChiakiTarget)atoi(arg_value(argc, argv, "--target", ps4 ? "1000" : "1000100"));
	info.host = host;
	info.broadcast = arg_flag(argc, argv, "--broadcast");
	info.psn_online_id = NULL;
	info.pin = (uint32_t)strtoul(pin, NULL, 10);
	info.holepunch_info = NULL;
	info.rudp = NULL;
	ChiakiRegist regist;
	ChiakiErrorCode err = chiaki_regist_start(&regist, &log, &info, regist_cb, NULL);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		printf("{\"ok\":false,\"error\":\"%s\"}\n", chiaki_error_string(err));
		return 1;
	}
	// The console answers within seconds or not at all.
	for(int i = 0; i < 300 && !regist_done; i++) sleep_ms(100);
	if(!regist_done)
	{
		chiaki_regist_stop(&regist);
		printf("{\"ok\":false,\"error\":\"the console did not answer - is it on and showing the PIN?\"}\n");
	}
	chiaki_regist_fini(&regist);
	return 0;
}

int main(int argc, char **argv)
{
#ifdef _WIN32
	_setmode(_fileno(stdout), _O_BINARY);
	InitializeCriticalSection(&out_lock);
	InitializeCriticalSection(&err_lock);
#endif
	if(argc > 1 && !strcmp(argv[1], "regist")) return regist_main(argc, argv);
	const char *host = arg_value(argc, argv, "--host", NULL);
	const char *regist = getenv("P5RP_REGIST_KEY");
	const char *morning = getenv("P5RP_MORNING");
	if(!host || !regist || !morning || strlen(morning) != 32)
	{
		fprintf(stderr, "usage: p5rp --host <ip> [--ps4] [--res 360|540|720|1080] [--fps 30|60] [--bitrate kbit] [--codec h264|h265] [--audio]\n"
			"with P5RP_REGIST_KEY and P5RP_MORNING (32 hex characters) in the environment\n");
		return 2;
	}
	static char outbuf[1 << 20];
	setvbuf(stdout, outbuf, _IOFBF, sizeof outbuf);

	if(chiaki_lib_init() != CHIAKI_ERR_SUCCESS) { event_line(NULL, NULL, "{\"event\":\"quit\",\"error\":true,\"reason\":\"library init failed\""); return 1; }
	ChiakiLog log;
	chiaki_log_init(&log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING, log_cb, NULL);

	ChiakiConnectInfo info;
	memset(&info, 0, sizeof info);
	info.ps5 = !arg_flag(argc, argv, "--ps4");
	info.host = host;
	// Filled to its whole length, the rest zero - no terminator is wanted.
	memcpy(info.regist_key, regist, strlen(regist) < sizeof info.regist_key ? strlen(regist) : sizeof info.regist_key);
	for(int i = 0; i < 16; i++) { unsigned v = 0; sscanf(morning + 2 * i, "%2x", &v); info.morning[i] = (uint8_t)v; }

	int res = atoi(arg_value(argc, argv, "--res", "720"));
	int fps = atoi(arg_value(argc, argv, "--fps", "30"));
	ChiakiVideoResolutionPreset rp = res <= 360 ? CHIAKI_VIDEO_RESOLUTION_PRESET_360p : res <= 540 ? CHIAKI_VIDEO_RESOLUTION_PRESET_540p
		: res <= 720 ? CHIAKI_VIDEO_RESOLUTION_PRESET_720p : CHIAKI_VIDEO_RESOLUTION_PRESET_1080p;
	chiaki_connect_video_profile_preset(&info.video_profile, rp, fps >= 60 ? CHIAKI_VIDEO_FPS_PRESET_60 : CHIAKI_VIDEO_FPS_PRESET_30);
	int bitrate = atoi(arg_value(argc, argv, "--bitrate", "0"));
	if(bitrate > 0) info.video_profile.bitrate = (unsigned)bitrate;
	codec_h265 = !strcmp(arg_value(argc, argv, "--codec", "h264"), "h265");
	info.video_profile.codec = codec_h265 ? CHIAKI_CODEC_H265 : CHIAKI_CODEC_H264;
	info.video_profile_auto_downgrade = true;
	info.enable_dualsense = false;
	info.packet_loss_max = 0.05;
	info.enable_idr_on_fec_failure = true;

	ChiakiErrorCode err = chiaki_session_init(&session, &info, &log);
	if(err != CHIAKI_ERR_SUCCESS) { event_line("detail", chiaki_error_string(err), "{\"event\":\"quit\",\"error\":true,\"reason\":\"session init failed\""); return 1; }
	chiaki_controller_state_set_idle(&controller);
	chiaki_session_set_event_cb(&session, event_cb, NULL);
	chiaki_session_set_video_sample_cb(&session, video_cb, NULL);
	static ChiakiAudioSink audio_sink;
	if(arg_flag(argc, argv, "--audio"))
	{
		audio_sink.user = NULL;
		audio_sink.header_cb = audio_header_cb;
		audio_sink.frame_cb = audio_frame_cb;
		chiaki_session_set_audio_sink(&session, &audio_sink);
	}
	event_line(NULL, NULL, "{\"event\":\"starting\",\"width\":%u,\"height\":%u,\"fps\":%u,\"bitrate\":%u,\"codec\":\"%s\"",
		info.video_profile.width, info.video_profile.height, info.video_profile.max_fps, info.video_profile.bitrate, codec_h265 ? "h265" : "h264");
	chiaki_session_start(&session);

#ifdef _WIN32
	CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);
#else
	pthread_t th; pthread_create(&th, NULL, stdin_thread, NULL); pthread_detach(th);
#endif

	uint64_t last = now_us(), last_frames = 0, last_bytes = 0;
	while(!quit_seen && !stop_requested)
	{
		sleep_ms(100);
		uint64_t t = now_us();
		if(t - last >= 5000000)
		{
			LOCK(out_lock);
			uint64_t f = frames, by = bytes_out, lo = frames_lost, re = frames_repaired;
			UNLOCK(out_lock);
			event_line(NULL, NULL, "{\"event\":\"stats\",\"fps\":%.1f,\"kbps\":%.0f,\"frames\":%llu,\"lost\":%llu,\"repaired\":%llu",
				(f - last_frames) * 1e6 / (double)(t - last), (by - last_bytes) * 8e3 / (double)(t - last),
				(unsigned long long)f, (unsigned long long)lo, (unsigned long long)re);
			last = t; last_frames = f; last_bytes = by;
		}
	}
	chiaki_session_stop(&session);
	chiaki_session_join(&session);
	chiaki_session_fini(&session);
	if(!quit_seen) event_line(NULL, NULL, "{\"event\":\"quit\",\"code\":1,\"error\":false,\"reason\":\"Stopped\"");
	return 0;
}
