package app.limen.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Reactiva el bloqueo después de reiniciar el teléfono, si estaba activo
 * antes del reinicio. Nota importante: esto NO evita que alguien
 * simplemente desinstale la app o la fuerce a detenerse desde Ajustes —
 * un mecanismo anti-desinstalación real (device admin / accesibilidad)
 * queda fuera de este alcance, es una capa de protección aparte.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences("limen_vpn_state", Context.MODE_PRIVATE)
        val wasActive = prefs.getBoolean("active", false)
        if (!wasActive) return

        val domains = prefs.getStringSet("domains", emptySet()) ?: emptySet()

        val serviceIntent = Intent(context, LimenVpnService::class.java).apply {
            action = LimenVpnService.ACTION_START
            putStringArrayListExtra(LimenVpnService.EXTRA_DOMAINS, ArrayList(domains))
        }
        ContextCompat.startForegroundService(context, serviceIntent)
    }
}
