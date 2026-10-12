Retrain the bid scratchpad's digit model (optional):
  curl -LO https://raw.githubusercontent.com/mnielsen/neural-networks-and-deep-learning/master/data/mnist.pkl.gz && mv mnist.pkl.gz /tmp/
  pip install numpy scipy && python3 train.py   # ~7 min on 1 CPU, writes model.json
  then rebuild ../../digits.js = 'const DIGIT_MODEL = ' + model.json + ';' + recognizer.js + 'Digits.load(DIGIT_MODEL);'
