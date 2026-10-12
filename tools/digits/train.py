import numpy as np, warnings, time, json, base64
warnings.filterwarnings('ignore')
from prep import load, norm, augment
tr, va, te = load()
X = np.concatenate([tr[0], va[0]]).reshape(-1,28,28); Y = np.concatenate([tr[1], va[1]])
rng = np.random.default_rng(1)
t = time.time()
base = np.stack([norm(x) for x in X])
augs = [np.stack([augment(x, rng) for x in X]) for _ in range(3)]
Xa = np.concatenate([base] + augs).reshape(-1, 784); Ya = np.tile(Y, 4)
Xt = np.stack([norm(x) for x in te[0].reshape(-1,28,28)]).reshape(-1,784); Yt = te[1]
Xta = np.stack([augment(x, rng) for x in te[0].reshape(-1,28,28)]).reshape(-1,784)
print('data', Xa.shape, round(time.time()-t), 's', flush=True)

sizes = [784, 256, 128, 10]
W = [rng.normal(0, np.sqrt(2/sizes[i]), (sizes[i], sizes[i+1])).astype(np.float32) for i in range(3)]
B = [np.zeros(sizes[i+1], np.float32) for i in range(3)]
params = W + B
m = [np.zeros_like(p) for p in params]; v = [np.zeros_like(p) for p in params]
def fwd(x, train=False):
    acts = [x]; h = x
    for i in range(3):
        z = h @ W[i] + B[i]
        if i < 2:
            h = np.maximum(z, 0)
            if train:
                mask = (rng.random(h.shape) > 0.2) / 0.8; h = h * mask; acts.append((h, mask))
            else: acts.append((h, None))
        else: h = z
    return h, acts
def acc(X_, Y_): return (fwd(X_)[0].argmax(1) == Y_).mean()
lr, step, bs = 1e-3, 0, 128
for ep in range(14):
    if ep == 9: lr = 3e-4
    if ep == 12: lr = 1e-4
    idx = rng.permutation(len(Xa))
    for s in range(0, len(idx), bs):
        b = idx[s:s+bs]; x, y = Xa[b], Ya[b]
        out, acts = fwd(x, True)
        p = np.exp(out - out.max(1, keepdims=True)); p /= p.sum(1, keepdims=True)
        g = p; g[np.arange(len(y)), y] -= 1; g /= len(y)
        gW, gB = [None]*3, [None]*3
        for i in (2, 1, 0):
            hin = acts[i] if i == 0 else acts[i][0]
            gW[i] = hin.T @ g; gB[i] = g.sum(0)
            if i > 0:
                g = g @ W[i].T
                h, mask = acts[i]
                g = g * (h > 0) * mask
        step += 1
        for j, (pp, gg) in enumerate(zip(params, gW + gB)):
            m[j] = 0.9*m[j] + 0.1*gg; v[j] = 0.999*v[j] + 0.001*gg*gg
            mh = m[j]/(1-0.9**step); vh = v[j]/(1-0.999**step)
            pp -= lr * mh / (np.sqrt(vh) + 1e-8)
    print(f'ep {ep} test {acc(Xt,Yt):.4f} test-aug {acc(Xta,Yt):.4f} {round(time.time()-t)}s', flush=True)

# Export: int8 per-layer quantization, base64
layers = []
for i in range(3):
    s = float(np.abs(W[i]).max() / 127)
    q = np.round(W[i] / s).astype(np.int8)
    layers.append({'in': sizes[i], 'out': sizes[i+1], 'scale': s, 'w': base64.b64encode(q.tobytes()).decode(), 'b': [round(float(x), 5) for x in B[i]]})
    W[i] = q.astype(np.float32) * s
print('quantized test', acc(Xt, Yt), acc(Xta, Yt))
json.dump(layers, open('model.json', 'w'))
np.save('sample_x.npy', Xt[:50]); np.save('sample_out.npy', fwd(Xt[:50])[0])
