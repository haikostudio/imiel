import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Users } from "lucide-react";
import type { TopContact } from "@/lib/hooks/useDashboard";
import { ContactAvatar } from "@/components/mail/ContactAvatar";

interface TopContactsProps {
  contacts: TopContact[];
}

export default function TopContacts({ contacts }: TopContactsProps) {
  const displayed = contacts.slice(0, 5);

  return (
    <Card data-ref="dashboard-contacts">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Users className="size-5 text-primary" />
          <CardTitle className="text-base">Top correspondants</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {displayed.length === 0 && (
          <p data-ref="dashboard-contacts-empty" className="py-8 text-center text-sm text-muted-foreground">
            Aucun contact
          </p>
        )}

        {displayed.map((contact, index) => (
          <div
            key={contact.email}
            data-ref="dashboard-contacts-item"
            className="flex items-center gap-3 rounded-md px-2 py-2"
          >
            <span className="w-5 text-center text-xs font-medium text-muted-foreground">
              {index + 1}
            </span>
            <ContactAvatar
              name={contact.name}
              email={contact.email}
              className="size-8 shrink-0"
              textClassName="text-xs"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {contact.name || contact.email}
              </p>
              {contact.name && (
                <p className="truncate text-xs text-muted-foreground">
                  {contact.email}
                </p>
              )}
            </div>
            <span className="shrink-0 text-sm font-medium text-muted-foreground">
              {contact.count}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
