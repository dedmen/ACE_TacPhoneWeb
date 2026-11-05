using System.Text.Json;
using TacPhone.RemoteServer.Protocol;

namespace TacPhone.RemoteServer.Tests.Protocol;

public sealed class SendResultTests
{
    [Fact]
    public void SendResult_CarriesRequestedDeliveredAndUnknown()
    {
        var json = ServerFrames.SendResult(2, 1, ["p_gone"]);

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        Assert.Equal("send-result", root.GetProperty("t").GetString());
        Assert.Equal(2, root.GetProperty("requested").GetInt32());
        Assert.Equal(1, root.GetProperty("delivered").GetInt32());

        var unknown = root.GetProperty("unknown");
        Assert.Equal(JsonValueKind.Array, unknown.ValueKind);
        Assert.Equal("p_gone", Assert.Single(unknown.EnumerateArray()).GetString());
    }

    [Fact]
    public void SendResult_WritesAnEmptyUnknownArray()
    {
        var json = ServerFrames.SendResult(0, 0, []);

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        Assert.Equal(JsonValueKind.Array, root.GetProperty("unknown").ValueKind);
        Assert.Empty(root.GetProperty("unknown").EnumerateArray());
    }
}
