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
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
        const val BASE_URL = "https://nailstudiopro-app.surge.sh"
        const val LOCAL_ASSET_MANICURE = "file:///android_asset/App_Manicure.html"
        const val LOCAL_ASSET_CLIENTE = "file:///android_asset/Pagina_Cliente.html"
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
                val safeEmail = email.trim().lowercase().replace("'", "")
                val deviceProof = "ANDROID_OS_VERIFIED_" + android.util.Base64.encodeToString(
                    ("NAIL_ACCOUNTS_V2:" + safeEmail).toByteArray(Charsets.UTF_8),
                    android.util.Base64.NO_WRAP
                )
                webView.post {
                    webView.evaluateJavascript(
                        "if (typeof window.onAndroidDeviceGoogleAccountSelected === 'function') { window.onAndroidDeviceGoogleAccountSelected('$safeEmail', '$deviceProof'); }",
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
                } catch (e: Exception) {
                    // Fallback para o OAuth 2.0 Oficial Direto com Google Cloud (sem servidor PC)
                    val oauthUrl = "https://accounts.google.com/o/oauth2/v2/auth" +
                        "?client_id=${"1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com"}" +
                        "&redirect_uri=" + Uri.encode("http://localhost:8080/oauth2callback") +
                        "&response_type=code" +
                        "&scope=" + Uri.encode("https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events") +
                        "&access_type=offline&prompt=consent%20select_account"
                    webView.loadUrl(oauthUrl)
                }
            }
        }
    }

    private fun hideSystemBars() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    /**
     * Intercepta retorno OAuth (localhost:8080/oauth2callback) e processa 100% localmente no APK
     */
    private fun interceptLocalOAuthRedirect(url: String): String? {
        if (url.startsWith("http://localhost:8080/") || url.startsWith("http://127.0.0.1:8080/")) {
            val parsed = Uri.parse(url)
            val code = parsed.getQueryParameter("code")
            if (!code.isNullOrBlank()) {
                return "$LOCAL_ASSET_MANICURE?google_oauth_code=${Uri.encode(code)}"
            }
            return LOCAL_ASSET_MANICURE
        }
        return null
    }

    /**
     * Intercepta URLs para abrir WhatsApp nativo, Instagram, Google Maps, Planilha Google ou rotas internas
     */
    private fun handleUrl(url: String): Boolean {
        try {
            // 1. Redirecionamento de OAuth do Google (localhost -> Processamento Local 100% Cloud-Direct no APK)
            val oauthLocalTarget = interceptLocalOAuthRedirect(url)
            if (oauthLocalTarget != null) {
                webView.loadUrl(oauthLocalTarget)
                return true
            }

            // 2. Arquivos locais empacotados no APK (Modo Offline / Cloud Direct)
            if (url.startsWith("file:///android_asset/")) {
                webView.loadUrl(url)
                return true
            }

            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase() ?: ""
            val host = uri.host?.lowercase() ?: ""

            // 3. WhatsApp: wa.me, api.whatsapp.com ou whatsapp://
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

            // 4. Telefone (tel:), E-mail (mailto:), Instagram ou Google Maps
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

            // 5. Página Cliente ou rotas internas da aplicação -> Carrega direto do Asset Local do APK (0ms e 100% independente!)
            if (url.contains("Pagina_Cliente.html")) {
                val q = uri.encodedQuery
                val target = if (!q.isNullOrEmpty()) "$LOCAL_ASSET_CLIENTE?$q" else LOCAL_ASSET_CLIENTE
                webView.loadUrl(target)
                return true
            }
            if (url.contains("App_Manicure.html") || url == BASE_URL || url == "$BASE_URL/") {
                val q = uri.encodedQuery
                val target = if (!q.isNullOrEmpty()) "$LOCAL_ASSET_MANICURE?$q" else LOCAL_ASSET_MANICURE
                webView.loadUrl(target)
                return true
            }

            // 6. Links externos como Planilha Google (docs.google.com), Drive, etc. (exceto accounts.google.com para OAuth)
            if (host.contains("docs.google.com") || host.contains("drive.google.com") || host.contains("calendar.google.com")) {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(intent)
                return true
            }

            // Padrão: carregar no WebView
            webView.loadUrl(url)
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
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.allowFileAccessFromFileURLs = true
            settings.allowUniversalAccessFromFileURLs = true
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
                    if (url != null) {
                        val oauthLocalTarget = interceptLocalOAuthRedirect(url)
                        if (oauthLocalTarget != null) {
                            view?.stopLoading()
                            view?.loadUrl(oauthLocalTarget)
                            return
                        }
                    }
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

                // Intercepta redirecionamento OAuth (localhost:8080) ou faz fallback para asset local se sem rede
                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    if (request?.isForMainFrame == true) {
                        val failedUrl = request.url?.toString() ?: ""
                        val oauthLocalTarget = interceptLocalOAuthRedirect(failedUrl)
                        if (oauthLocalTarget != null) {
                            view?.loadUrl(oauthLocalTarget)
                            return
                        }
                        if (failedUrl.contains("Pagina_Cliente.html")) {
                            val query = request.url?.encodedQuery
                            val target = if (!query.isNullOrEmpty()) "$LOCAL_ASSET_CLIENTE?$query" else LOCAL_ASSET_CLIENTE
                            view?.loadUrl(target)
                            return
                        } else if (!failedUrl.startsWith("file:///android_asset/")) {
                            view?.loadUrl(LOCAL_ASSET_MANICURE)
                            return
                        }
                    }
                    super.onReceivedError(view, request, error)
                }

                override fun onReceivedHttpError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    errorResponse: WebResourceResponse?
                ) {
                    super.onReceivedHttpError(view, request, errorResponse)
                    val code = errorResponse?.statusCode ?: 200
                    if (request?.isForMainFrame == true && (code == 530 || code == 502 || code == 503 || code == 404)) {
                        val failedUrl = request.url?.toString() ?: ""
                        if (failedUrl.contains("Pagina_Cliente.html")) {
                            val query = request.url?.encodedQuery
                            val target = if (!query.isNullOrEmpty()) "$LOCAL_ASSET_CLIENTE?$query" else LOCAL_ASSET_CLIENTE
                            view?.loadUrl(target)
                        } else if (failedUrl.contains("App_Manicure.html") || failedUrl == "$BASE_URL/") {
                            view?.loadUrl(LOCAL_ASSET_MANICURE)
                        }
                    }
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

            // Carrega instantaneamente do Asset Interno do APK (100% independente de PC ou servidor externo)
            loadUrl(LOCAL_ASSET_MANICURE)
        }

        // Ajusta automaticamente o padding inferior quando o teclado virtual (IME) sobe no modo imersivo
        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(0, 0, 0, imeInsets.bottom)
            insets
        }

        setContentView(webView)

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
