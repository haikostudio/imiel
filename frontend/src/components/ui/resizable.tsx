"use client"

import { useRef, useCallback, useEffect } from "react"
import { GripVerticalIcon } from "lucide-react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  const separatorRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const el = separatorRef.current
    const indicator = indicatorRef.current
    if (!el || !indicator) return

    const rect = el.getBoundingClientRect()
    const isHorizontal = el.getAttribute("aria-orientation") === "horizontal"

    if (isHorizontal) {
      indicator.style.left = `${e.clientX - rect.left}px`
      indicator.style.top = "50%"
    } else {
      indicator.style.left = "50%"
      indicator.style.top = `${e.clientY - rect.top}px`
    }
  }, [])

  useEffect(() => {
    const el = separatorRef.current
    if (!el) return

    el.addEventListener("mousemove", handleMouseMove)
    return () => el.removeEventListener("mousemove", handleMouseMove)
  }, [handleMouseMove])

  return (
    <ResizablePrimitive.Separator
      elementRef={separatorRef}
      data-slot="resizable-handle"
      className={cn(
        "group/handle relative flex w-px items-center justify-center",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
        "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden",
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        "aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2",
        "bg-border transition-colors duration-200 hover:bg-orange-400",
        className
      )}
      {...props}
    >
      {/* Indicateur flottant qui suit le pointeur */}
      <div
        ref={indicatorRef}
        className="pointer-events-none absolute z-20 opacity-0 transition-opacity duration-200 group-hover/handle:opacity-100"
      >
        <div className="flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-orange-400 shadow-lg shadow-orange-400/25 group-aria-[orientation=horizontal]/handle:rotate-90">
          <GripVerticalIcon className="size-3.5 text-white" />
        </div>
      </div>

      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border opacity-100 transition-opacity duration-200 group-hover/handle:opacity-0 group-aria-[orientation=horizontal]/handle:rotate-90">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
