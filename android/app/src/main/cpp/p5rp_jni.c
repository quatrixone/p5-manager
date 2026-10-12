// SPDX-License-Identifier: AGPL-3.0-only
//
// The session, native, for the Android app. It is p5rp without the process
// boundary: the same libchiaki calls, with the records that p5rp writes to
// a pipe delivered as JNI calls instead.
//
// Java side: com.p5manager.app.rp.NativeSession
//   start(host, registKey, morning, ps4, width, height, fps)  -> 0 or an error
//   stop()
//   setControllerState(buttons, l2, r2, lx, ly, rx, ry)
//   requestIdr()
// and back, on the session's own threads:
//   onVideo(byte[] frame, boolean keyFrame, long timestampUs)
//   onAudioHeader(int channels, int rate, int frameSize)
//   onAudio(byte[] packet)
//   onEvent(int kind, String text)   0 connected, 1 quit, 2 log
#include <jni.h>
#include <string.h>
#include <stdlib.h>
#include <android/log.h>

#include <chiaki/session.h>
#include <chiaki/log.h>

#define TAG "p5rp"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

enum { EVENT_CONNECTED = 0, EVENT_QUIT = 1, EVENT_LOG = 2 };

static JavaVM *vm;
static jobject listener;          // global ref to the NativeSession
static jmethodID on_video, on_audio_header, on_audio, on_event;
static ChiakiSession session;
static ChiakiLog chiaki_log;
static ChiakiControllerState controller;
static int session_live;

static JNIEnv *attach(int *attached)
{
	JNIEnv *env = NULL;
	*attached = 0;
	if((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) == JNI_OK)
		return env;
	if((*vm)->AttachCurrentThread(vm, &env, NULL) != JNI_OK)
		return NULL;
	*attached = 1;
	return env;
}

static void detach(int attached)
{
	if(attached)
		(*vm)->DetachCurrentThread(vm);
}

static void say_event(int kind, const char *text)
{
	int attached;
	JNIEnv *env = attach(&attached);
	if(!env)
		return;
	jstring s = text ? (*env)->NewStringUTF(env, text) : NULL;
	(*env)->CallVoidMethod(env, listener, on_event, (jint)kind, s);
	if(s)
		(*env)->DeleteLocalRef(env, s);
	detach(attached);
}

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	__android_log_print(level == CHIAKI_LOG_ERROR ? ANDROID_LOG_WARN : ANDROID_LOG_DEBUG, TAG, "%s", msg);
	if(level == CHIAKI_LOG_ERROR || level == CHIAKI_LOG_WARNING)
		say_event(EVENT_LOG, msg);
}

static bool video_cb(uint8_t *buf, size_t size, int32_t frames_lost, bool frame_recovered, void *user)
{
	(void)frames_lost; (void)frame_recovered; (void)user;
	int attached;
	JNIEnv *env = attach(&attached);
	if(!env)
		return false;
	jbyteArray array = (*env)->NewByteArray(env, (jsize)size);
	if(!array)
	{
		detach(attached);
		return false;
	}
	(*env)->SetByteArrayRegion(env, array, 0, (jsize)size, (const jbyte *)buf);
	// A key frame starts with an SPS or an IDR slice; the decoder needs to
	// know, and looking for the NAL type here saves it a second pass.
	jboolean key = JNI_FALSE;
	for(size_t i = 0; i + 4 < size; i++)
	{
		if(buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1)
		{
			unsigned type = buf[i + 3] & 0x1f;
			if(type == 5 || type == 7)
			{
				key = JNI_TRUE;
				break;
			}
		}
	}
	(*env)->CallVoidMethod(env, listener, on_video, array, key, (jlong)0);
	(*env)->DeleteLocalRef(env, array);
	detach(attached);
	return true;
}

static void audio_header_cb(ChiakiAudioHeader *header, void *user)
{
	(void)user;
	int attached;
	JNIEnv *env = attach(&attached);
	if(!env)
		return;
	(*env)->CallVoidMethod(env, listener, on_audio_header,
		(jint)header->channels, (jint)header->rate, (jint)header->frame_size);
	detach(attached);
}

static void audio_frame_cb(uint8_t *buf, size_t size, void *user)
{
	(void)user;
	int attached;
	JNIEnv *env = attach(&attached);
	if(!env)
		return;
	jbyteArray array = (*env)->NewByteArray(env, (jsize)size);
	if(array)
	{
		(*env)->SetByteArrayRegion(env, array, 0, (jsize)size, (const jbyte *)buf);
		(*env)->CallVoidMethod(env, listener, on_audio, array);
		(*env)->DeleteLocalRef(env, array);
	}
	detach(attached);
}

static void event_cb(ChiakiEvent *event, void *user)
{
	(void)user;
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
			say_event(EVENT_CONNECTED, NULL);
			break;
		case CHIAKI_EVENT_QUIT:
			say_event(EVENT_QUIT, event->quit.reason_str ? event->quit.reason_str
				: chiaki_quit_reason_string(event->quit.reason));
			break;
		default:
			break;
	}
}

static int hex_to_bytes(const char *hex, uint8_t *out, size_t out_size)
{
	size_t len = strlen(hex);
	if(len != out_size * 2)
		return 0;
	for(size_t i = 0; i < out_size; i++)
	{
		unsigned value;
		if(sscanf(hex + i * 2, "%2x", &value) != 1)
			return 0;
		out[i] = (uint8_t)value;
	}
	return 1;
}

JNIEXPORT jint JNICALL
Java_com_p5manager_app_rp_NativeSession_nativeStart(JNIEnv *env, jobject thiz,
	jstring host_, jstring regist_key_, jstring morning_, jboolean ps4,
	jint width, jint height, jint fps, jint bitrate)
{
	if(session_live)
		return -2;
	(*env)->GetJavaVM(env, &vm);
	if(listener)
		(*env)->DeleteGlobalRef(env, listener);
	listener = (*env)->NewGlobalRef(env, thiz);
	jclass cls = (*env)->GetObjectClass(env, thiz);
	on_video = (*env)->GetMethodID(env, cls, "onVideo", "([BZJ)V");
	on_audio_header = (*env)->GetMethodID(env, cls, "onAudioHeader", "(III)V");
	on_audio = (*env)->GetMethodID(env, cls, "onAudio", "([B)V");
	on_event = (*env)->GetMethodID(env, cls, "onEvent", "(ILjava/lang/String;)V");
	if(!on_video || !on_audio_header || !on_audio || !on_event)
		return -3;

	chiaki_log_init(&chiaki_log, CHIAKI_LOG_ALL & ~CHIAKI_LOG_VERBOSE, log_cb, NULL);
	if(chiaki_lib_init() != CHIAKI_ERR_SUCCESS)
		return -4;

	const char *host = (*env)->GetStringUTFChars(env, host_, NULL);
	const char *regist_key = (*env)->GetStringUTFChars(env, regist_key_, NULL);
	const char *morning = (*env)->GetStringUTFChars(env, morning_, NULL);

	ChiakiConnectInfo info = { 0 };
	info.ps5 = !ps4;
	info.host = host;
	info.video_profile.width = (unsigned)width;
	info.video_profile.height = (unsigned)height;
	info.video_profile.max_fps = (unsigned)fps;
	info.video_profile.bitrate = (unsigned)bitrate;
	info.video_profile_auto_downgrade = true;
	info.enable_keyboard = false;
	info.enable_dualsense = false;
	memset(info.regist_key, 0, sizeof(info.regist_key));
	strncpy(info.regist_key, regist_key, sizeof(info.regist_key) - 1);
	int ok = hex_to_bytes(morning, info.morning, sizeof(info.morning));

	ChiakiErrorCode err = ok ? chiaki_session_init(&session, &info, &chiaki_log) : CHIAKI_ERR_INVALID_DATA;
	(*env)->ReleaseStringUTFChars(env, host_, host);
	(*env)->ReleaseStringUTFChars(env, regist_key_, regist_key);
	(*env)->ReleaseStringUTFChars(env, morning_, morning);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		LOGE("session init failed: %s", chiaki_error_string(err));
		return -5;
	}

	chiaki_controller_state_set_idle(&controller);
	chiaki_session_set_event_cb(&session, event_cb, NULL);
	chiaki_session_set_video_sample_cb(&session, video_cb, NULL);
	static ChiakiAudioSink audio_sink;
	audio_sink.user = NULL;
	audio_sink.header_cb = audio_header_cb;
	audio_sink.frame_cb = audio_frame_cb;
	chiaki_session_set_audio_sink(&session, &audio_sink);
	chiaki_session_start(&session);
	session_live = 1;
	LOGI("session started towards the console");
	return 0;
}

JNIEXPORT void JNICALL
Java_com_p5manager_app_rp_NativeSession_nativeStop(JNIEnv *env, jobject thiz)
{
	(void)env; (void)thiz;
	if(!session_live)
		return;
	session_live = 0;
	chiaki_session_stop(&session);
	chiaki_session_join(&session);
	chiaki_session_fini(&session);
}

JNIEXPORT void JNICALL
Java_com_p5manager_app_rp_NativeSession_nativeSetControllerState(JNIEnv *env, jobject thiz,
	jint buttons, jint l2, jint r2, jint lx, jint ly, jint rx, jint ry)
{
	(void)env; (void)thiz;
	if(!session_live)
		return;
	controller.buttons = (uint32_t)buttons;
	controller.l2_state = (uint8_t)l2;
	controller.r2_state = (uint8_t)r2;
	controller.left_x = (int16_t)lx;
	controller.left_y = (int16_t)ly;
	controller.right_x = (int16_t)rx;
	controller.right_y = (int16_t)ry;
	chiaki_session_set_controller_state(&session, &controller);
}

JNIEXPORT void JNICALL
Java_com_p5manager_app_rp_NativeSession_nativeRequestIdr(JNIEnv *env, jobject thiz)
{
	(void)env; (void)thiz;
	if(session_live)
		chiaki_session_request_idr(&session);
}
