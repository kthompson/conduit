using Conduit.Provider.Claude;
using Conduit.Provider.Core;
using Conduit.Provider.Fake;

namespace Conduit.Cli;

internal static class Drivers
{
    /// <summary>Every driver the executable ships. The server never references a driver package itself.</summary>
    public static IReadOnlyList<IProviderDriver> All() => [new ClaudeDriver(), new FakeDriver()];
}
