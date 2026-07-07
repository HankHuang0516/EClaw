import SwiftUI
import WidgetKit

private let appGroupIdentifier = "__APP_GROUP__"
private let pendingCountKey = "__PENDING_COUNT_KEY__"
private let updatedAtKey = "__UPDATED_AT_KEY__"

struct NeedsYouEntry: TimelineEntry {
  let date: Date
  let pendingCount: Int
  let updatedAt: Date?
}

struct NeedsYouProvider: TimelineProvider {
  func placeholder(in context: Context) -> NeedsYouEntry {
    NeedsYouEntry(date: Date(), pendingCount: 3, updatedAt: Date())
  }

  func getSnapshot(in context: Context, completion: @escaping (NeedsYouEntry) -> Void) {
    completion(loadEntry())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<NeedsYouEntry>) -> Void) {
    let entry = loadEntry()
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(5 * 60))))
  }

  private func loadEntry() -> NeedsYouEntry {
    guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else {
      return NeedsYouEntry(date: Date(), pendingCount: 0, updatedAt: nil)
    }

    let pendingCount = max(0, defaults.integer(forKey: pendingCountKey))
    let updatedAtSeconds = defaults.double(forKey: updatedAtKey)
    let updatedAt = updatedAtSeconds > 0 ? Date(timeIntervalSince1970: updatedAtSeconds) : nil
    return NeedsYouEntry(date: Date(), pendingCount: pendingCount, updatedAt: updatedAt)
  }
}

struct NeedsYouWidgetView: View {
  let entry: NeedsYouEntry

  var body: some View {
    ZStack {
      LinearGradient(
        colors: [Color(red: 0.11, green: 0.12, blue: 0.20), Color(red: 0.06, green: 0.32, blue: 0.36)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )

      VStack(alignment: .leading, spacing: 10) {
        Text("E-Claw")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.white.opacity(0.72))

        Spacer(minLength: 0)

        if entry.pendingCount > 0 {
          Text("\(min(entry.pendingCount, 99))")
            .font(.system(size: 44, weight: .black, design: .rounded))
            .foregroundStyle(.white)
            .minimumScaleFactor(0.72)

          Text("Needs you")
            .font(.headline.weight(.bold))
            .foregroundStyle(.white)
        } else {
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 34, weight: .bold))
            .foregroundStyle(.green)

          Text("All clear")
            .font(.headline.weight(.bold))
            .foregroundStyle(.white)
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
    .needsYouWidgetBackground()
  }
}

extension View {
  @ViewBuilder
  func needsYouWidgetBackground() -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      self.containerBackground(for: .widget) {
        Color(red: 0.11, green: 0.12, blue: 0.20)
      }
    } else {
      self.background(Color(red: 0.11, green: 0.12, blue: 0.20))
    }
  }
}

struct NeedsYouWidget: Widget {
  let kind = "__WIDGET_KIND__"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: NeedsYouProvider()) { entry in
      NeedsYouWidgetView(entry: entry)
    }
    .configurationDisplayName("E-Claw Needs You")
    .description("Shows unresolved Needs-you requests from E-Claw.")
    .supportedFamilies([.systemSmall])
  }
}

@main
struct NeedsYouWidgetBundle: WidgetBundle {
  var body: some Widget {
    NeedsYouWidget()
  }
}
