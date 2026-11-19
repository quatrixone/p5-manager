/*
 * LZ4 Compression - narrow API surface.
 */

#pragma once

#include "websrv.h"

int lzc_api_request(const http_request_t *req, const char *url);
int lzc_api_icon_request(const http_request_t *req);
int lzc_api_handoff_state_request(const http_request_t *req);
void lzc_api_recover_on_startup(void);
/* Releases ShadowMountPlus mounts the app asked for (on-demand images). */
void lzc_api_release_on_demand_mounts(void);
