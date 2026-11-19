package com.example.nailstudiopro

import android.accounts.AccountManager
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : ComponentActivity() {

    companion object {
        // TROQUE pela URL real do Worker após o deploy (veja worker/README.md)
        const val BASE_URL = "https://nail-studio-pro.SEU-SUBDOMINIO.workers.dev"
    }

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    // Seletor Nativo de Contas Google Reais cadastradas no aparelho Android (AccountManager)
    private val accountPickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val email = result.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
            val accType = result.data?.getStringExtra(AccountManager.KEY_ACCOUNT_TYPE)
            if (!email.isNullOrBlank() && (accType == null || accType == "com.google")) {
                val safeEmail = email.trim().lowercase().replace("'", "").replace("\\", "")
                webView.post {
                    webView.evaluateJavascript(
                        "if (typeof window.onAndroidDeviceGoogleAccountSelected === 'function') { window.onAndroidDeviceGoogleAccountSelected('$safeEmail'); }",
                        null
                    )
                }
            }
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult

        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val results: Array<Uri>? = when {
                data?.clipData != null -> {
                    val count = data.clipData!!.itemCount
                    Array(count) { i -> data.clipData!!.getItemAt(i).uri }
                }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
            callback.onReceiveValue(results)
        } else {
            callback.onReceiveValue(null)
        }
    }

    inner class AndroidNativeBridge(private val context: Context) {
        @JavascriptInterface
        fun copyToClipboard(text: String) {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("NailStudioPro", text)
            clipboard.setPrimaryClip(clip)
        }

        @JavascriptInterface
        fun openExternalUrl(url: String) {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(intent)
            } catch (_: Exception) {}
        }

        /**
         * Abre o seletor oficial do Sistema Android mostrando apenas as Contas Google reais ("com.google")
         * cadastradas neste celular.
         */
        @JavascriptInterface
        fun pickDeviceGoogleAccount() {
            runOnUiThread {
                try {
                    @Suppress("DEPRECATION")
                    val intent = AccountManager.newChooseAccountIntent(
                        null,
                        null,
                        arrayOf("com.google"),
                        null,
                        null,
                        null,
                        null
                    )
                    accountPickerLauncher.launch(intent)
                } catch (_: Exception) {
                    // Sem seletor de contas no aparelho: a usuária digita o e-mail na página.
                }
            }
        }

        /**
         * Abre no navegador do sistema (o Google bloqueia login dentro de WebView).
         * Só aceita o início do fluxo OAuth do próprio Worker.
         */
        @JavascriptInterface
        fun openInSystemBrowser(url: String) {
            if (!url.startsWith("$BASE_URL/api/oauth/start")) return
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(intent)
            } catch (_: Exception) {}
        }
    }

    private fun hideSystemBars() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    /**
     * Trata o retorno do OAuth: nailstudiopro://auth?<query> vira
     * BASE_URL/App_Manicure.html#<query> (a página lê o resultado só do fragmento).
     */
    private fun handleAuthIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "nailstudiopro" && data.host == "auth") {
            val q = data.encodedQuery ?: ""
            webView.loadUrl("$BASE_URL/App_Manicure.html#$q")
        }
    }

    /**
     * Intercepta URLs para abrir WhatsApp nativo, Instagram, Google Maps, Planilha Google ou rotas internas
     */
    private fun handleUrl(url: String): Boolean {
        try {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase() ?: ""
            val host = uri.host?.lowercase() ?: ""

            // 1. WhatsApp: wa.me, api.whatsapp.com ou whatsapp://
            if (scheme == "whatsapp" || host == "wa.me" || host == "api.whatsapp.com" || url.contains("api.whatsapp.com") || url.contains("wa.me")) {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                try {
                    startActivity(intent)
                    return true
                } catch (e: Exception) {
                    val webIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(webIntent)
                    return true
                }
            }

            // 2. Telefone (tel:), E-mail (mailto:), Instagram ou Google Maps
            if (
                scheme == "tel" ||
                scheme == "mailto" ||
                host.contains("instagram.com") ||
                host.contains("maps.google.com") ||
                url.contains("google.com/maps")
            ) {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(intent)
                return true
            }

            // 3. Links externos como Planilha Google (docs.google.com), Drive, etc. (exceto accounts.google.com para OAuth)
            if (host.contains("docs.google.com") || host.contains("drive.google.com") || host.contains("calendar.google.com")) {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(intent)
                return true
            }

            // Rotas do Worker (App_Manicure.html, Pagina_Cliente.html e API) ficam no WebView
            if (url.startsWith(BASE_URL)) {
                webView.loadUrl(url)
                return true
            }

            // Qualquer outro endereço abre no navegador do sistema
            startActivity(Intent(Intent.ACTION_VIEW, uri).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK })
            return true
        } catch (e: Exception) {
            e.printStackTrace()
            return false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Modo Imersivo: recolhe barra de notificação do topo e comandos de navegação de baixo
        WindowCompat.setDecorFitsSystemWindows(window, false)
        hideSystemBars()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.allowFileAccessFromFileURLs = false
            settings.allowUniversalAccessFromFileURLs = false
            settings.setSupportMultipleWindows(true)
            settings.javaScriptCanOpenWindowsAutomatically = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            clearCache(true)
            // Remove "; wv" para evitar bloqueio 403 disallowed_useragent no login Google OAuth
            val cleanUa = settings.userAgentString.replace("; wv", "").replace("wv", "")
            settings.userAgentString = "$cleanUa NailStudioProAndroidApp/2.2"
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true

            addJavascriptInterface(AndroidNativeBridge(this@MainActivity), "AndroidNative")

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    hideSystemBars()
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    return handleUrl(url)
                }

                @Deprecated("Deprecated in Java")
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    val u = url ?: return false
                    return handleUrl(u)
                }
            }

            // Suporte a upload de fotos do catálogo (<input type="file">) e janelas popup (target="_blank")
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = filePathCallback
                    return try {
                        val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "image/*"
                        }
                        fileChooserLauncher.launch(intent)
                        true
                    } catch (e: Exception) {
                        this@MainActivity.filePathCallback = null
                        false
                    }
                }

                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: Message?
                ): Boolean {
                    val transport = resultMsg?.obj as? WebView.WebViewTransport
                    val tempWebView = WebView(this@MainActivity)
                    tempWebView.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                            val url = request?.url?.toString() ?: return false
                            return handleUrl(url)
                        }

                        @Deprecated("Deprecated in Java")
                        override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                            val u = url ?: return false
                            return handleUrl(u)
                        }
                    }
                    transport?.webView = tempWebView
                    resultMsg?.sendToTarget()
                    return true
                }
            }

        }

        // Ajusta automaticamente o padding inferior quando o teclado virtual (IME) sobe no modo imersivo
        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(0, 0, 0, imeInsets.bottom)
            insets
        }

        setContentView(webView)

        // Abertura normal ou retorno do OAuth (nailstudiopro://auth?...)
        if (intent?.data?.scheme == "nailstudiopro") {
            handleAuthIntent(intent)
        } else {
            webView.loadUrl("$BASE_URL/App_Manicure.html")
        }

        // Integração do Botão Voltar físico/gesto do Android com as gavetas, modais e abas do App
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(typeof window.handleAndroidBackButton === 'function') ? window.handleAndroidBackButton() : 'NONE'"
                ) { result ->
                    val clean = result?.trim('"') ?: "NONE"
                    if (clean == "HANDLED") {
                        return@evaluateJavascript
                    }
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            hideSystemBars()
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
