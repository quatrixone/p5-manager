package com.p5manager.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Where the phone is told which P5 Manager to open: an address typed in, or
 * the QR code the web UI shows in Settings. A server that has been used
 * once goes straight through on the next start.
 */
class SetupActivity : AppCompatActivity() {
    private lateinit var store: ServerStore

    private val scan = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val url = normalizeServerUrl(text)
        if (url == null) {
            Toast.makeText(this, R.string.address_unusable, Toast.LENGTH_LONG).show()
        } else {
            open(Server(url, ""))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        // Straight in when this phone has been here before; the UI below is
        // for the first run and for switching.
        if (savedInstanceState == null && intent.getBooleanExtra(EXTRA_PICK, false).not()) {
            store.current?.let { open(it); return }
        }
        setContentView(R.layout.activity_setup)

        val urlLayout = findViewById<TextInputLayout>(R.id.urlLayout)
        val url = findViewById<TextInputEditText>(R.id.url)
        val name = findViewById<TextInputEditText>(R.id.name)
        url.setText(store.current?.url ?: "")
        urlLayout.placeholderText = getString(R.string.server_hint)

        findViewById<MaterialButton>(R.id.connect).setOnClickListener {
            val normalized = normalizeServerUrl(url.text?.toString().orEmpty())
            if (normalized == null) {
                urlLayout.error = getString(R.string.address_unusable)
            } else {
                urlLayout.error = null
                open(Server(normalized, name.text?.toString().orEmpty().trim()))
            }
        }
        findViewById<MaterialButton>(R.id.scan).setOnClickListener {
            scan.launch(ScanOptions().apply {
                setPrompt(getString(R.string.scan_prompt))
                setBeepEnabled(false)
                setOrientationLocked(false)
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            })
        }
        showSaved()
    }

    private fun showSaved() {
        val saved = store.all()
        findViewById<TextView>(R.id.savedLabel).visibility = if (saved.isEmpty()) View.GONE else View.VISIBLE
        val list = findViewById<LinearLayout>(R.id.saved)
        list.removeAllViews()
        for (server in saved) {
            val row = layoutInflater.inflate(R.layout.row_server, list, false)
            row.findViewById<TextView>(R.id.serverLabel).text = server.label
            row.findViewById<TextView>(R.id.serverUrl).text = server.url
            row.setOnClickListener { open(server) }
            row.findViewById<MaterialButton>(R.id.forget).setOnClickListener {
                store.forget(server.url)
                showSaved()
            }
            list.addView(row)
        }
    }

    private fun open(server: Server) {
        store.remember(server)
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    companion object {
        /** Set when the user asked to switch, so we do not jump straight back in. */
        const val EXTRA_PICK = "pick"
    }
}
