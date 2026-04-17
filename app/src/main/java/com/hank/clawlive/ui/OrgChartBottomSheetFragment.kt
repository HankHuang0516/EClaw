package com.hank.clawlive.ui

import android.annotation.SuppressLint
import android.app.Dialog
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageButton
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.hank.clawlive.R
import com.hank.clawlive.data.local.DeviceManager

/**
 * Bottom sheet containing the web Org Chart view (embedded=orgchart mode).
 * Keeps MainActivity chrome visible instead of routing to a full dashboard page.
 */
class OrgChartBottomSheetFragment : BottomSheetDialogFragment() {

    private var webView: WebView? = null

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val dialog = super.onCreateDialog(savedInstanceState) as BottomSheetDialog
        dialog.setOnShowListener {
            val sheet = dialog.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)
            sheet?.let {
                val behavior = BottomSheetBehavior.from(it)
                val screenHeight = resources.displayMetrics.heightPixels
                behavior.peekHeight = (screenHeight * 0.9).toInt()
                behavior.state = BottomSheetBehavior.STATE_EXPANDED
                behavior.skipCollapsed = true
            }
        }
        return dialog
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_org_chart_sheet, container, false)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        view.findViewById<ImageButton>(R.id.btnCloseOrgSheet).setOnClickListener { dismiss() }

        val container = view.findViewById<FrameLayout>(R.id.orgChartWebViewContainer)
        val wv = WebView(requireContext()).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#0D0D1A"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.defaultTextEncodingName = "UTF-8"
            settings.userAgentString = settings.userAgentString + " EClawAndroid"
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
        }
        container.addView(wv)
        webView = wv

        val dm = DeviceManager.getInstance(requireContext())
        val url = buildString {
            append("https://eclawbot.com/portal/dashboard.html?embed=1&view=orgchart")
            if (dm.deviceId.isNotBlank() && dm.deviceSecret.isNotBlank()) {
                append("&deviceId=")
                append(dm.deviceId)
                append("&deviceSecret=")
                append(dm.deviceSecret)
            }
        }
        wv.loadUrl(url)
    }

    override fun onDestroyView() {
        webView?.destroy()
        webView = null
        super.onDestroyView()
    }

    companion object {
        const val TAG = "OrgChartBottomSheet"
        fun newInstance() = OrgChartBottomSheetFragment()
    }
}
