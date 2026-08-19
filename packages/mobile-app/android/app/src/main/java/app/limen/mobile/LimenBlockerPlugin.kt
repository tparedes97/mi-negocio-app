package app.limen.mobile

import android.content.Intent
import android.net.VpnService
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.Plugin
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Puente entre el JS de la app (src/app.js) y LimenVpnService. La parte
 * delicada es el permiso de VPN: Android exige que el usuario lo confirme
 * en un diálogo del sistema la primera vez (VpnService.prepare), así que
 * startBlocking puede quedar "pendiente" hasta que vuelva ese resultado.
 */
@CapacitorPlugin(name = "LimenBlocker")
class LimenBlockerPlugin : Plugin() {

    private var pendingDomains: ArrayList<String> = ArrayList()

    override fun load() {
        super.load()
        LimenVpnService.blockedAttemptListener = { domain ->
            val data = JSObject()
            data.put("domain", domain)
            notifyListeners("blockedAttempt", data)
        }
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val result = JSObject()
        result.put("active", LimenVpnService.isRunning)
        call.resolve(result)
    }

    @PluginMethod
    fun startBlocking(call: PluginCall) {
        val domainsArray = call.getArray("domains")
        val domains = ArrayList<String>()
        if (domainsArray != null) {
            for (i in 0 until domainsArray.length()) {
                domains.add(domainsArray.getString(i))
            }
        }
        pendingDomains = domains

        val prepareIntent = VpnService.prepare(context)
        if (prepareIntent != null) {
            // Primera vez (o el usuario revocó el permiso antes) — hay que
            // mostrar el diálogo del sistema pidiendo autorización.
            startActivityForResult(call, prepareIntent, "handleVpnPermissionResult")
        } else {
            launchVpnService(domains)
            val result = JSObject()
            result.put("active", true)
            call.resolve(result)
        }
    }

    @ActivityCallback
    private fun handleVpnPermissionResult(call: PluginCall?, result: androidx.activity.result.ActivityResult) {
        if (call == null) return
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            launchVpnService(pendingDomains)
            val out = JSObject()
            out.put("active", true)
            call.resolve(out)
        } else {
            call.reject("El usuario no autorizó el permiso de VPN, necesario para el bloqueo.")
        }
    }

    @PluginMethod
    fun stopBlocking(call: PluginCall) {
        val intent = Intent(context, LimenVpnService::class.java).apply {
            action = LimenVpnService.ACTION_STOP
        }
        context.startService(intent)
        val result = JSObject()
        result.put("active", false)
        call.resolve(result)
    }

    private fun launchVpnService(domains: ArrayList<String>) {
        val intent = Intent(context, LimenVpnService::class.java).apply {
            action = LimenVpnService.ACTION_START
            putStringArrayListExtra(LimenVpnService.EXTRA_DOMAINS, domains)
        }
        androidx.core.content.ContextCompat.startForegroundService(context, intent)
    }
}
