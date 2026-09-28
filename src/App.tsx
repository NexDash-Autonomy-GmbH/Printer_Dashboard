import { useEffect } from "react"

import { ScanProgressDialog } from "@/components/ScanProgressDialog"
import { Toaster } from "@/components/ui/sonner"
import { watchForNewDeploy } from "@/lib/deployWatch"
import { RecipientsProvider } from "@/recipients/context"
import { RecipientsDashboard } from "@/recipients/Recipients"
import { ReviewDialog } from "@/scan/ReviewDialog"

export function App() {
  // A tab left open keeps running the bundle it loaded, so a deployed fix can
  // look like it never shipped. This offers the reload rather than forcing it.
  useEffect(() => watchForNewDeploy(), [])

  return (
    <RecipientsProvider>
      <RecipientsDashboard />
      <ScanProgressDialog />
      {/* Built on the alert dialog, so it portals to the end of <body> on
          the layer that dialog already uses. Being later in the DOM is what
          puts it over the scan progress screen; it adds no layer of its own. */}
      <ReviewDialog />
      <Toaster />
    </RecipientsProvider>
  )
}

export default App
