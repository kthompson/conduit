import type { FieldMetadata } from "@conform-to/react";
import type * as React from "react";
import { Label } from "#app/components/ui/label.tsx";

export function Field({
  label,
  field,
  hint,
  children,
}: {
  label: string;
  field: FieldMetadata;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={field.id}>{label}</Label>
      {children}
      {hint ? (
        <p id={`${field.id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <p id={field.errorId} className="min-h-0 text-sm text-destructive empty:hidden">
        {field.errors?.join(" ")}
      </p>
    </div>
  );
}
