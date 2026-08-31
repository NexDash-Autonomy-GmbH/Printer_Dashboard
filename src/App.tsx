import { Toaster } from "@/components/ui/sonner"
import { RecipientsProvider } from "@/recipients/context"
import { RecipientsDashboard } from "@/recipients/Recipients"

export function App() {
  return (
    <RecipientsProvider>
      <RecipientsDashboard />
      <Toaster />
    </RecipientsProvider>
  )
}

export default App
