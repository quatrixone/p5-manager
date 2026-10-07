// SPDX-License-Identifier: AGPL-3.0-only
//
// p5rp - Remote Play session helper for P5 Manager, built on libchiaki
// (chiaki-ng, AGPL-3.0). One process holds one session with a console.
//
//   p5rp --host <ip> [--ps4] [--res 360|540|720|1080] [--fps 30|60]
//        [--bitrate <kbit/s>] [--codec h264|h265]
//
// The pairing keys come in the environment, not on the command line, where
// every user of the machine could read them:
//   P5RP_REGIST_KEY   the console's regist key (up to 16 characters)
//   P5RP_MORNING      32 hex characters
//
// stdout  the video, as the console encoded it (Annex B), one record a frame:
//           'V'  flags(1)  length(4, big endian)  time(8, big endian, us)  data
//         flags: 1 = key frame, 2 = frames were lost before it, 4 = repaired by FEC
// stderr  one JSON object a line: {"event":"connected"}, {"event":"quit",...},
//         {"event":"stats",...}, {"event":"log",...}
// stdin   one command a line:
//           btn <name> <0|1>      cross moon box pyramid left right up down
//                                 l1 r1 l3 r3 options share touchpad ps
//           trigger <l2|r2> <0..255>
//           stick <l|r> <x> <y>   -32768..32767
//           idle                  everything released
//           standby               put the console into rest mode
//           stop                  end the session
//         End of input ends the session too: the helper never outlives the
//         program that started it.
#include <chiaki/common.h>
#include <chiaki/controller.h>
#include <chiaki/log.h>
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

static bool video_cb(uint8_t *buf, size_t size, int32_t lost, bool recovered, void *user)
{
	(void)user;
	uint8_t head[14];
	uint64_t t = now_us();
	head[0] = 'V';
	head[1] = (uint8_t)((is_key_frame(buf, size, codec_h265) ? 1 : 0) | (lost > 0 ? 2 : 0) | (recovered ? 4 : 0));
	head[2] = (uint8_t)(size >> 24); head[3] = (uint8_t)(size >> 16); head[4] = (uint8_t)(size >> 8); head[5] = (uint8_t)size;
	for(int i = 0; i < 8; i++) head[6 + i] = (uint8_t)(t >> (56 - 8 * i));
	LOCK(out_lock);
	fwrite(head, 1, sizeof head, stdout);
	fwrite(buf, 1, size, stdout);
	fflush(stdout);
	frames++; bytes_out += size;
	if(lost > 0) frames_lost += (uint64_t)lost;
	if(recovered) frames_repaired++;
	UNLOCK(out_lock);
	return true;
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
	if(!strcmp(a, "idle")) chiaki_controller_state_set_idle(&controller);
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

int main(int argc, char **argv)
{
#ifdef _WIN32
	_setmode(_fileno(stdout), _O_BINARY);
	InitializeCriticalSection(&out_lock);
	InitializeCriticalSection(&err_lock);
#endif
	const char *host = arg_value(argc, argv, "--host", NULL);
	const char *regist = getenv("P5RP_REGIST_KEY");
	const char *morning = getenv("P5RP_MORNING");
	if(!host || !regist || !morning || strlen(morning) != 32)
	{
		fprintf(stderr, "usage: p5rp --host <ip> [--ps4] [--res 360|540|720|1080] [--fps 30|60] [--bitrate kbit] [--codec h264|h265]\n"
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
