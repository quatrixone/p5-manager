package com.p5manager.app

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * The manager itself: the web UI of the server this phone is pointed at.
 * Remote Play still plays the server's stream here; the native session
 * takes its place in the next stage, and this stays the fallback.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var store: ServerStore
    private lateinit var web: WebView
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        val server = store.current ?: run {
            startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_PICK, true))
            finish()
            return
        }

        web = WebView(this)
        setContentView(web)
        // The page is a live console view; letting the screen sleep in the
        // middle of a session is never what the user wants.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Keep the manager in the app; send anything else (a project
                // page, a GitHub issue) to the browser.
                val host = request.url.host ?: return false
                return if (server.url.contains(host)) false else {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    true
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(getString(R.string.offline, server.url))
                    .setPositiveButton(R.string.retry) { _, _ -> view.loadUrl(server.url) }
                    .setNegativeButton(R.string.switch_server) { _, _ -> pickServer() }
                    .setCancelable(false)
                    .show()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // Remote Play's player goes fullscreen; so does the WebView.
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                fullscreenView = view
                fullscreenCallback = callback
                addContentView(view, android.view.ViewGroup.LayoutParams(-1, -1))
                web.visibility = View.GONE
            }

            override fun onHideCustomView() {
                (fullscreenView?.parent as? android.view.ViewGroup)?.removeView(fullscreenView)
                fullscreenView = null
                fullscreenCallback?.onCustomViewHidden()
                web.visibility = View.VISIBLE
            }

            // The page only ever asks for what it needs to pair and stream.
            override fun onPermissionRequest(request: PermissionRequest) = request.grant(request.resources)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    fullscreenView != null -> web.webChromeClient?.onHideCustomView()
                    web.canGoBack() -> web.goBack()
                    else -> finish()
                }
            }
        })

        web.loadUrl(savedInstanceState?.getString(STATE_URL) ?: server.url)
    }

    private fun pickServer() {
        startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_PICK, true))
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_URL, web.url)
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val STATE_URL = "url"
    }
}
