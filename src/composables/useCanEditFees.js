// Whether the meet and event fee editors should render at all.
//
// Every fee endpoint they load sits behind requireMeetEditor on the server
// (org_admin or meet_manager), so a club or region admin opening Edit meet
// used to fire three config fetches, get three 403s and three red toasts.
// And with payments switched off the panels only ever said "coming soon".
// So both conditions have to hold before we mount them, which also means
// they never fetch anything they can't use.
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'

export function useCanEditFees() {
  const auth = useAuthStore()
  const features = useFeaturesStore()
  return computed(() =>
    features.enabled('payments') && auth.hasAnyRole(['org_admin', 'meet_manager']))
}
