import { useEffect } from "react"

import { ScanProgressDialog } from "@/components/ScanProgressDialog"
import { Toaster } from "@/components/ui/sonner"
import { watchForNewDeploy } from "@/lib/deployWatch"
import { RecipientsProvider } from "@/recipients/context"
import { RecipientsDashboard } from "@/recipients/Recipients"

export function App() {
  // A tab left open keeps running the bundle it loaded, so a deployed fix can
  // look like it never shipped. This offers the reload rather than forcing it.
  useEffect(() => watchForNewDeploy(), [])

  return (
    <RecipientsProvider>
      <RecipientsDashboard />
      <ScanProgressDialog />
      <Toaster />
    </RecipientsProvider>
  )
}

export default App
