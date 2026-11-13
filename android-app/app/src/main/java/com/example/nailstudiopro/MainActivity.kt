package com.example.nailstudiopro

import android.accounts.Account
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
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Nail Studio Pro — casca Android (WebView) com login Google NATIVO.
 *
 * Por que nativo? O Google bloqueia login OAuth dentro de WebView
 * (erro 403 "disallowed_useragent"). Por isso:
 *  - Login: Credential Manager ("Fazer login com o Google") devolve um ID Token
 *    assinado pelo Google, que a página envia para a API verificar.
 *  - Google Agenda: AuthorizationClient pede a permissão calendar.events e
 *    devolve um "server auth code", trocado pelo servidor (Apps Script) por um
 *    refresh token que NUNCA fica no celular.
 *
 * Requer no Google Cloud Console um cliente OAuth do tipo "Android" com o
 * pacote com.nailstudio.pro + SHA-1 da chave que assina o APK (ver backend/README.md).
 */
class MainActivity : ComponentActivity() {

    companion object {
        const val LOCAL_ASSET_MANICURE = "file:///android_asset/App_Manicure.html"
        const val LOCAL_ASSET_CLIENTE = "file:///android_asset/Pagina_Cliente.html"
        const val CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events"
    }

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val credentialManager by lazy { CredentialManager.create(this) }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val results: Array<Uri>? = when {
                data?.clipData != null -> Array(data.clipData!!.itemCount) { i -> data.clipData!!.getItemAt(i).uri }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
            callback.onReceiveValue(results)
        } else {
            callback.onReceiveValue(null)
        }
    }

    // Tela de consentimento da Google Agenda (quando o Google precisa perguntar à usuária)
    private val calendarConsentLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            try {
                val auth = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(result.data)
                deliverCalendarAuth(auth)
            } catch (e: Exception) {
                sendJs("onNativeCalendarError", "Não foi possível concluir a permissão: ${e.message}")
            }
        } else {
            sendJs("onNativeCalendarError", "CANCELADO")
        }
    }

    /** Chama uma função global da página com um argumento de texto (escapado em JSON). */
    private fun sendJs(function: String, value: String) {
        val arg = JSONObject.quote(value)
        webView.post {
            webView.evaluateJavascript("if (typeof window.$function === 'function') { window.$function($arg); }", null)
        }
    }

    // ------------------------------------------------------------------ LOGIN
    private fun startGoogleSignIn(webClientId: String) {
        if (webClientId.isBlank() || webClientId.contains("COLE_AQUI")) {
            sendJs("onNativeGoogleError", "GOOGLE_CLIENT_ID não configurado no config.js do app.")
            return
        }
        val option = GetSignInWithGoogleOption.Builder(webClientId).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        lifecycleScope.launch {
            try {
                val result = credentialManager.getCredential(this@MainActivity, request)
                val credential = result.credential
                if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    val google = GoogleIdTokenCredential.createFrom(credential.data)
                    sendJs("onNativeGoogleIdToken", google.idToken)
                } else {
                    sendJs("onNativeGoogleError", "O Android devolveu um tipo de login inesperado.")
                }
            } catch (e: GetCredentialCancellationException) {
                sendJs("onNativeGoogleError", "CANCELADO")
            } catch (e: NoCredentialException) {
                sendJs("onNativeGoogleError", "Nenhuma conta Google neste celular. Adicione em Configurações > Contas e tente de novo.")
            } catch (e: GoogleIdTokenParsingException) {
                sendJs("onNativeGoogleError", "Resposta do Google inválida. Tente novamente.")
            } catch (e: GetCredentialException) {
                sendJs("onNativeGoogleError", "Falha no login Google (${e.type}). Verifique o cliente OAuth Android (SHA-1) no Google Cloud.")
            }
        }
    }

    private fun signOutGoogle() {
        lifecycleScope.launch {
            try { credentialManager.clearCredentialState(ClearCredentialStateRequest()) } catch (_: Exception) {}
        }
    }

    // --------------------------------------------------------- GOOGLE AGENDA
    private fun startCalendarAuthorization(webClientId: String, email: String) {
        if (webClientId.isBlank() || webClientId.contains("COLE_AQUI")) {
            sendJs("onNativeCalendarError", "GOOGLE_CLIENT_ID não configurado.")
            return
        }
        val builder = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(CALENDAR_SCOPE)))
            .requestOfflineAccess(webClientId, true)
        if (email.contains("@")) builder.setAccount(Account(email, "com.google"))
        Identity.getAuthorizationClient(this)
            .authorize(builder.build())
            .addOnSuccessListener { auth ->
                val pending = auth.pendingIntent
                if (auth.hasResolution() && pending != null) {
                    calendarConsentLauncher.launch(IntentSenderRequest.Builder(pending.intentSender).build())
                } else {
                    deliverCalendarAuth(auth)
                }
            }
            .addOnFailureListener { e ->
                sendJs("onNativeCalendarError", "Falha ao pedir permissão da agenda: ${e.message}")
            }
    }

    private fun deliverCalendarAuth(auth: AuthorizationResult) {
        val code = auth.serverAuthCode
        if (code.isNullOrBlank()) {
            sendJs("onNativeCalendarError", "O Google não enviou o código de autorização. Tente de novo.")
        } else {
            sendJs("onNativeCalendarAuthCode", code)
        }
    }

    // --------------------------------------------------- PONTE JAVASCRIPT
    inner class AndroidNativeBridge(private val context: Context) {
        @JavascriptInterface
        fun copyToClipboard(text: String) {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("NailStudioPro", text))
        }

        @JavascriptInterface
        fun openExternalUrl(url: String) {
            runOnUiThread { openExternally(url) }
        }

        @JavascriptInterface
        fun signInWithGoogle(webClientId: String) {
            runOnUiThread { startGoogleSignIn(webClientId) }
        }

        @JavascriptInterface
        fun authorizeCalendar(webClientId: String, email: String) {
            runOnUiThread { startCalendarAuthorization(webClientId, email) }
        }

        @JavascriptInterface
        fun signOut() {
            runOnUiThread { signOutGoogle() }
        }

        @JavascriptInterface
        fun appVersion(): String = "3.0.0"
    }

    private fun hideSystemBars() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun openExternally(url: String): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK })
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Páginas do próprio app ficam no WebView (assets). Todo o resto (WhatsApp,
     * Google Agenda, Maps, Instagram, planilha, sites) abre no app/navegador
     * certo — assim nenhuma página de terceiros recebe a ponte AndroidNative.
     */
    private fun handleUrl(url: String): Boolean {
        if (url.startsWith("file:///android_asset/")) return false
        val uri = Uri.parse(url)
        val q = uri.encodedQuery
        if (url.contains("Pagina_Cliente.html")) {
            webView.loadUrl(if (!q.isNullOrEmpty()) "$LOCAL_ASSET_CLIENTE?$q" else LOCAL_ASSET_CLIENTE)
            return true
        }
        if (url.contains("App_Manicure.html")) {
            webView.loadUrl(if (!q.isNullOrEmpty()) "$LOCAL_ASSET_MANICURE?$q" else LOCAL_ASSET_MANICURE)
            return true
        }
        openExternally(url)
        return true
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        hideSystemBars()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            // Necessário para a página local (file://) chamar a API do Apps Script
            @Suppress("DEPRECATION")
            settings.allowUniversalAccessFromFileURLs = true
            settings.setSupportMultipleWindows(true)
            settings.javaScriptCanOpenWindowsAutomatically = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.userAgentString = settings.userAgentString + " NailStudioProAndroidApp/3.0"
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
            }

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

                // window.open / target="_blank": abre fora do app
                override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
                    val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                    val temp = WebView(this@MainActivity)
                    temp.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                            val url = request?.url?.toString() ?: return true
                            handleUrl(url)
                            temp.destroy()
                            return true
                        }
                    }
                    transport.webView = temp
                    resultMsg.sendToTarget()
                    return true
                }
            }

            loadUrl(LOCAL_ASSET_MANICURE)
        }

        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(0, 0, 0, imeInsets.bottom)
            insets
        }

        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(typeof window.handleAndroidBackButton === 'function') ? window.handleAndroidBackButton() : 'NONE'"
                ) { result ->
                    val clean = result?.trim('"') ?: "NONE"
                    if (clean == "HANDLED") return@evaluateJavascript
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
        if (hasFocus) hideSystemBars()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
