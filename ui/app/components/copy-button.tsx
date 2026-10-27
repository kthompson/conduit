import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "#app/components/ui/button.tsx";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
          return undefined;
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
