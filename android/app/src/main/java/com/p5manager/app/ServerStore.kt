package com.p5manager.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL

/**
 * The P5 Manager servers this phone knows. One is current; the rest are
 * remembered so switching back does not mean typing an address again.
 */
data class Server(val url: String, val name: String) {
    val label: String get() = name.ifBlank { urlHost(url) }
}

fun urlHost(url: String): String = try { URL(url).host } catch (_: Exception) { url }

/**
 * What the user typed, as something this app can open: a bare host becomes
 * http, a trailing slash goes away, and anything that is not http(s) is
 * refused rather than handed to a WebView.
 */
fun normalizeServerUrl(input: String): String? {
    val text = input.trim()
    if (text.isEmpty()) return null
    val withScheme = if (text.contains("://")) text else "http://$text"
    val url = try { URL(withScheme) } catch (_: Exception) { return null }
    if (url.protocol != "http" && url.protocol != "https") return null
    if (url.host.isNullOrBlank()) return null
    val port = if (url.port == -1) "" else ":${url.port}"
    val path = url.path.trimEnd('/')
    return "${url.protocol}://${url.host}$port$path"
}

class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("servers", Context.MODE_PRIVATE)

    var current: Server?
        get() = prefs.getString("current", null)?.let { url -> all().firstOrNull { it.url == url } }
        set(value) = prefs.edit().apply {
            if (value == null) remove("current") else putString("current", value.url)
        }.apply()

    fun all(): List<Server> {
        val raw = prefs.getString("list", "[]") ?: "[]"
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).map {
                val o = array.getJSONObject(it)
                Server(o.getString("url"), o.optString("name", ""))
            }
        } catch (_: Exception) { emptyList() }
    }

    fun remember(server: Server) {
        val list = all().filterNot { it.url == server.url } + server
        save(list)
        current = server
    }

    fun forget(url: String) {
        save(all().filterNot { it.url == url })
        if (current?.url == url) current = null
    }

    private fun save(list: List<Server>) {
        val array = JSONArray()
        list.forEach { array.put(JSONObject().put("url", it.url).put("name", it.name)) }
        prefs.edit().putString("list", array.toString()).apply()
    }
}
