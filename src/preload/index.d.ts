import type { SheepTextApi } from '../shared/types'

declare global {
  interface Window {
    sheepText: SheepTextApi
  }
}

export {}
